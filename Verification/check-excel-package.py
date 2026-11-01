#!/usr/bin/env python3
"""Independently validate synthetic workbooks produced by actual Swift exporter."""

from decimal import Decimal
from pathlib import Path, PurePosixPath
import posixpath
import re
import sys
import xml.etree.ElementTree as ET
import zipfile


MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
DOCUMENT_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
CONTENT = "http://schemas.openxmlformats.org/package/2006/content-types"
NS = {"m": MAIN, "r": REL, "c": CONTENT}
DETAIL_SHEETS = ["Read Me", "Monthly Summary", "Pay Periods", "Categories", "Transactions"]
BUCKET_HEADERS = ["Month", "Period", "Start Day", "End Day", "Plan", "Bucket",
                  "Contribution", "Withdrawal", "NetContribution"]


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def column_number(reference):
    value = 0
    for character in reference:
        if not character.isalpha():
            break
        require("A" <= character <= "Z", "Cell references must be canonical A1 coordinates")
        value = value * 26 + ord(character) - ord("A") + 1
    require(value > 0, "Cell reference has no column")
    return value


def column_name(number):
    require(number >= 1, "Column number must be positive")
    result = ""
    while number:
        number, remainder = divmod(number - 1, 26)
        result = chr(ord("A") + remainder) + result
    return result


def cells_from_sheet(root):
    values = {}
    for cell in root.findall("m:sheetData/m:row/m:c", NS):
        reference = cell.attrib["r"]
        require(reference not in values, "Worksheet must not contain duplicate cell coordinates")
        require(re.fullmatch(r"[A-Z]+[1-9][0-9]*", reference), "Cell coordinates must use valid A1 notation")
        require(cell.find("m:f", NS) is None, "Financial values must be snapshots, not executable formulas")
        if cell.attrib.get("t") == "inlineStr":
            value = "".join(cell.find("m:is", NS).itertext())
        else:
            raw_value = cell.findtext("m:v", None, NS)
            value = None if raw_value is None else Decimal(raw_value)
        values[reference] = {"value": value, "style": int(cell.attrib.get("s", "0"))}
    return values


def rows_from_sheet(root):
    rows = []
    for row in root.findall("m:sheetData/m:row", NS):
        values = {}
        for cell in row.findall("m:c", NS):
            require(cell.find("m:f", NS) is None, "User text must never become an Excel formula")
            reference = cell.attrib["r"]
            require(reference not in values, "Duplicate cell coordinates")
            if cell.attrib.get("t") == "inlineStr":
                value = "".join(cell.find("m:is", NS).itertext())
            else:
                raw_value = cell.findtext("m:v", None, NS)
                value = None if raw_value is None else Decimal(raw_value)
            values[reference] = value
        rows.append(values)
    require(rows, "Every worksheet must have at least a header row")
    header = {column_number(key): value for key, value in rows[0].items()}
    require(all(isinstance(value, str) for value in header.values()), "Headers must be text cells")
    decoded = []
    for values in rows[1:]:
        decoded.append({label: next((value for ref, value in values.items()
                                    if column_number(ref) == column), None)
                        for column, label in header.items()})
    return decoded, list(header.values())


def read_workbook(path, *, expects_buckets=False):
    with zipfile.ZipFile(path) as archive:
        require(archive.testzip() is None, "Every ZIP entry must have a valid CRC")
        names = archive.namelist()
        require(len(names) == len(set(names)), "OOXML must not contain duplicate package paths")
        require(all(not PurePosixPath(name).is_absolute() and ".." not in PurePosixPath(name).parts
                    for name in names), "ZIP names must not escape the package")
        roots = {}
        for name in names:
            require(name.endswith((".xml", ".rels")), "Unexpected binary or secret file in workbook")
            roots[name] = ET.fromstring(archive.read(name))
            require(roots[name].find(".//m:f", NS) is None, "Workbook contains an executable formula")
            require(roots[name].find(".//m:externalReference", NS) is None,
                    "Workbook must not link to external data")
            if name.endswith(".rels"):
                for relationship in roots[name].findall("r:Relationship", NS):
                    require(relationship.attrib.get("TargetMode") != "External",
                            "Workbook must not link to an external resource")
        require("[Content_Types].xml" in roots and "_rels/.rels" in roots,
                "Required package metadata is missing")
        for name, root in roots.items():
            if not name.endswith(".rels"):
                continue
            base = "" if name == "_rels/.rels" else str(PurePosixPath(name).parent.parent)
            for relationship in root.findall("r:Relationship", NS):
                target = relationship.attrib["Target"]
                resolved = target.lstrip("/") if target.startswith("/") else posixpath.normpath(
                    posixpath.join(base, target))
                require(resolved in roots, "Every internal OOXML relationship must resolve")
        overrides = {item.attrib["PartName"] for item in
                     roots["[Content_Types].xml"].findall("c:Override", NS)}
        workbook = roots["xl/workbook.xml"]
        relationships = {item.attrib["Id"]: item.attrib["Target"] for item in
                         roots["xl/_rels/workbook.xml.rels"].findall("r:Relationship", NS)}
        sheets = workbook.findall("m:sheets/m:sheet", NS)
        sheet_names = [sheet.attrib["name"] for sheet in sheets]
        detail_names = DETAIL_SHEETS + (["Savings Buckets"] if expects_buckets else [])
        require(len(sheet_names) > len(detail_names)
                and sheet_names[-len(detail_names):] == detail_names,
                "Calendar-year overviews must precede the five unchanged detail sheets")
        overview_names = sheet_names[:-len(detail_names)]
        require(all(re.fullmatch(r"CY[0-9]{2,4} Data", name) for name in overview_names),
                "Overview sheets must use calendar-year names")
        result = {}
        styles = roots["xl/styles.xml"].findall("m:cellXfs/m:xf", NS)
        require(styles, "Workbook must define its cell styles")
        for sheet in sheets:
            identifier = sheet.attrib[f"{{{DOCUMENT_REL}}}id"]
            target = relationships[identifier]
            package_name = target.lstrip("/") if target.startswith("/") else "xl/" + target
            require(package_name in roots and "/" + package_name in overrides,
                    "Every worksheet relationship and content type must resolve")
            for cell in roots[package_name].findall("m:sheetData/m:row/m:c", NS):
                require(0 <= int(cell.attrib.get("s", "0")) < len(styles),
                        "Every cell style index must exist")
            name = sheet.attrib["name"]
            if name in detail_names:
                result[name] = rows_from_sheet(roots[package_name])
            else:
                result[name] = {"cells": cells_from_sheet(roots[package_name]),
                                "root": roots[package_name], "styles": roots["xl/styles.xml"]}
        selected_years = sorted({int(row["Month"].split("-")[0])
                                 for row in result["Monthly Summary"][0]})
        expected_overviews = [f"CY{year % 100:02} Data" if 2000 <= year <= 2099
                              else f"CY{year:04} Data" for year in selected_years]
        require(overview_names == expected_overviews,
                "Overview sheets must cover exactly the selected years in calendar order")
        if expects_buckets:
            require(result["Savings Buckets"][1] == BUCKET_HEADERS,
                    "Savings detail must expose only the selected period fields, not goals or all-time balances")
            require(result["Savings Buckets"][0], "Blank-only bucket entries must not create a bucket sheet")
        raw = b"".join(archive.read(name) for name in names)
        require(b"12345678-1234-1234-1234-123456789ABC" not in raw,
                "Internal transaction UUID leaked into workbook")
        require(b"UNSELECTED-PRIVATE-RECORD" not in raw and b"777777.77" not in raw,
                "Unselected financial record leaked into workbook")
        require(b"MyBudget.lock" not in raw and b"passcode.json" not in raw,
                "Passcode or lock preferences leaked into workbook")
        return result, raw


def one(rows, **fields):
    selected = [row for row in rows if all(row.get(key) == value for key, value in fields.items())]
    require(len(selected) == 1, f"Expected one row matching {fields}, got {len(selected)}")
    return selected[0]


def overview_value(overview, reference):
    return overview["cells"].get(reference, {}).get("value")


def style_parts(overview, reference):
    style = overview["cells"][reference]["style"]
    stylesheet = overview["styles"]
    xf = stylesheet.findall("m:cellXfs/m:xf", NS)[style]
    font = stylesheet.findall("m:fonts/m:font", NS)[int(xf.attrib.get("fontId", "0"))]
    fill = stylesheet.findall("m:fills/m:fill", NS)[int(xf.attrib.get("fillId", "0"))]
    return xf, font, fill


def color_suffix(element, path):
    color = element.find(path, NS)
    return None if color is None else color.attrib.get("rgb", "").upper()[-6:]


def date_header(month, year, start, end, payday=None):
    payday_text = "not set" if payday is None else f"{month} {payday}"
    return f"{month} {year} · Days {start}–{end} · Payday {payday_text}"


def validate_overview(overview, headers, *, extra_categories=(), actual_blocks=()):
    cells = overview["cells"]
    root = overview["root"]
    block_count = len(headers)
    total_due_row = 18 + len(extra_categories)
    leftover_row = total_due_row + 1
    labels = {3: "Income", 4: "Additional income", 5: "Savings withdrawals",
              7: "Home / Rent", 8: "Car", 9: "Insurance", 10: "Phone",
              11: "Grocery / Food", 12: "Gas", 13: "Electric", 14: "Savings deposits",
              15: "Credit Card", 16: "Misc.", 17: "Going-out",
              total_due_row: "Total Due", leftover_row: "Left Over"}
    labels.update({18 + index: category for index, category in enumerate(extra_categories)})
    expected_merges = []
    formats = {int(item.attrib["numFmtId"]): item.attrib["formatCode"]
               for item in overview["styles"].findall("m:numFmts/m:numFmt", NS)}
    formats[2] = "0.00"  # OOXML's built-in two-decimal format.
    for block, header in enumerate(headers):
        first_column = block * 4 + 1
        projected = column_name(first_column)
        actual = column_name(first_column + 1)
        line_item = column_name(first_column + 2)
        spacer = column_name(first_column + 3)
        expected_merges.append(f"{projected}1:{line_item}1")
        require(overview_value(overview, f"{projected}1") == header,
                "Merged date headers must preserve selected month, day range, and payday")
        for row in (2, 6):
            require([overview_value(overview, f"{column}{row}")
                     for column in (projected, actual, line_item)]
                    == ["Projected", "Actual", "Line Item"],
                    "Each pay-period block must repeat the three familiar column headings")
        for row, label in labels.items():
            require(overview_value(overview, f"{line_item}{row}") == label,
                    f"Calendar-year overview lost the {label} line")
        require(all(value["value"] is None for ref, value in cells.items()
                    if column_number(ref) == first_column + 3),
                f"Spacer column {spacer} must remain empty")
        for offset, expected_width in enumerate(("11", "11", "22", "1.5")):
            index = first_column + offset
            width = next((Decimal(item.attrib["width"]) for item in root.findall("m:cols/m:col", NS)
                          if int(item.attrib["min"]) <= index <= int(item.attrib["max"])), None)
            require(width == Decimal(expected_width), "Amount, label, and spacer widths must match the layout")
        for row in (1, 2, 6, leftover_row):
            references = [f"{projected}{row}"] if row == 1 else [f"{col}{row}" for col in (projected, actual, line_item)]
            for reference in references:
                require(reference in cells, "Overview header and result styles must be explicit")
                _, _, fill = style_parts(overview, reference)
                require(color_suffix(fill, "m:patternFill/m:fgColor") == "FFF2CC",
                        "Date, column, and remaining headers must use pale yellow")
    merges = [item.attrib["ref"] for item in root.findall("m:mergeCells/m:mergeCell", NS)]
    require(merges == expected_merges, "Each period needs exactly one three-column merged date header")
    pane = root.find("m:sheetViews/m:sheetView/m:pane", NS)
    require(pane is not None and pane.attrib.get("ySplit") == "2"
            and pane.attrib.get("topLeftCell") == "A3", "Overview must freeze its first two header rows")
    for reference, cell in cells.items():
        xf, font, _ = style_parts(overview, reference)
        name = font.find("m:name", NS)
        size = font.find("m:sz", NS)
        alignment = xf.find("m:alignment", NS)
        require(name is not None and name.attrib.get("val") == "Calibri"
                and size is not None and Decimal(size.attrib["val"]) == Decimal(12),
                "Calendar-year cells must use the requested Calibri 12 font")
        require(alignment is not None and alignment.attrib.get("horizontal") == "center",
                "Calendar-year cells must be centered")
        if isinstance(cell["value"], Decimal):
            require(formats.get(int(xf.attrib.get("numFmtId", "0"))) == "0.00",
                    "Overview money values must display two decimal places")
    expected_actual_cells = {f"{column_name(block * 4 + 2)}{leftover_row}" for block in actual_blocks}
    seen_actual_cells = set()
    priorities = set()
    differential_styles = overview["styles"].findall("m:dxfs/m:dxf", NS)
    for formatting in root.findall("m:conditionalFormatting", NS):
        reference = formatting.attrib["sqref"]
        require(reference in expected_actual_cells and reference not in seen_actual_cells,
                "Color rules must target only entered Actual remaining cells")
        seen_actual_cells.add(reference)
        projected = f"{column_name(column_number(reference) - 1)}{leftover_row}"
        rules = formatting.findall("m:cfRule", NS)
        require(len(rules) == 2, "Each Actual remaining value needs exactly red/green comparison rules")
        operators = set()
        for rule in rules:
            require(rule.attrib.get("type") == "cellIs", "Use numeric comparison rules for remaining")
            operator = rule.attrib["operator"]
            require(operator in {"lessThan", "greaterThanOrEqual"} and operator not in operators,
                    "Remaining needs complementary below/at-or-above comparisons")
            operators.add(operator)
            formulas = rule.findall("m:formula", NS)
            require(len(formulas) == 1 and formulas[0].text == projected,
                    "Actual must compare to its own period's Projected value, never the first period")
            priority = int(rule.attrib["priority"])
            require(priority > 0 and priority not in priorities, "Color rule priorities must be unique")
            priorities.add(priority)
            differential = differential_styles[int(rule.attrib["dxfId"])]
            expected_color = "FFC7CE" if operator == "lessThan" else "C5E0B4"
            require(color_suffix(differential, "m:fill/m:patternFill/m:fgColor") == expected_color,
                    "Remaining must use the requested red/green conditional colors")
    require(seen_actual_cells == expected_actual_cells,
            "Every period with both plans entered, including explicit zero, needs comparison colors")


def validate(directory):
    without_notes, raw_without = read_workbook(directory / "without-notes.xlsx")
    with_notes, raw_with = read_workbook(directory / "with-notes.xlsx")
    require(b"PRIVATE-NOTE-TEST" not in raw_without and b"PRIVATE-NOTE-SECOND" not in raw_without,
            "Notes must be absent when inclusion was not selected")
    require("Notes" not in without_notes["Transactions"][1],
            "Excluded notes should not be advertised as an empty exported column")
    require(b"PRIVATE-NOTE-TEST" in raw_with and b"PRIVATE-NOTE-SECOND" in raw_with,
            "Explicitly included notes were lost")

    summaries, _ = without_notes["Monthly Summary"]
    require(len(summaries) == 1, "One selected month should yield exactly one monthly summary")
    summary = one(summaries, Month="2026-01")
    expected = {"Budgeted Income": "2200", "Budgeted Expenses": "200",
                "Budgeted Savings Deposits": "300", "Budgeted Savings Withdrawals": "0",
                "Budgeted Remaining": "1700", "Realistic Income": "1926.50",
                "Unlogged Expenses": "150.60", "Logged Expenses": "0.30",
                "Realistic Expenses": "150.90", "Savings Deposits": "150.25",
                "Savings Withdrawals": "10", "Savings Change": "140.25",
                "Realistic Remaining": "1635.35", "Expense Budget Remaining": "49.10"}
    for label, amount in expected.items():
        require(summary[label] == Decimal(amount), f"Incorrect exact-cent monthly result: {label}")
    require(summary["Currency"] == "USD", "Workbook currency must be explicit")

    periods, _ = without_notes["Pay Periods"]
    require(len(periods) == 4, "Two periods each need a Budgeted and Realistic row")
    first = one(periods, Month="2026-01", Period=Decimal(1), Plan="Realistic")
    second = one(periods, Month="2026-01", Period=Decimal(2), Plan="Realistic")
    require(first["Start Day"] == Decimal(1) and first["End Day"] == Decimal(14)
            and second["Start Day"] == Decimal(15) and second["End Day"] == Decimal(31),
            "Pay-period boundaries changed during export")
    require(first["Logged Expenses"] == Decimal("0.10")
            and second["Logged Expenses"] == Decimal("0.20"),
            "Transactions must follow the saved period day and count once")

    categories, _ = without_notes["Categories"]
    blank = one(categories, Month="2026-01", Period=Decimal(1), Plan="Budgeted", Category="Gas")
    explicit_zero = one(categories, Month="2026-01", Period=Decimal(2), Plan="Budgeted", Category="Gas")
    require(blank["Manual Amount"] is None and explicit_zero["Manual Amount"] == Decimal(0),
            "Blank manual entries must remain distinct from explicitly entered zero")
    home = one(categories, Month="2026-01", Period=Decimal(1), Plan="Realistic", Category="Home")
    require(home["Manual Amount"] == Decimal("100.10")
            and home["Logged Amount"] == Decimal("0.10")
            and home["Total Amount"] == Decimal("100.20"),
            "Category export must preserve manual versus logged spending without duplication")

    transactions, _ = with_notes["Transactions"]
    require(len(transactions) == 2, "The two reported expenses must each export exactly once")
    note = one(transactions, Category="Home")["Notes"]
    require(note.startswith('=HYPERLINK("https://example.invalid","PRIVATE-NOTE-TEST")')
            and "&<>\" 😀" in note and "\x01" not in note,
            "Formula-like notes must remain literal Unicode text with valid XML escaping")

    empty, _ = read_workbook(directory / "empty-month.xlsx")
    require(not empty["Transactions"][0], "Empty months must not invent reported transactions")
    empty_summary = one(empty["Monthly Summary"][0], Month="2026-02")
    require(empty_summary["Realistic Remaining"] == Decimal(0), "An empty month must total zero")
    monthly, _ = read_workbook(directory / "monthly.xlsx")
    weekly, _ = read_workbook(directory / "weekly.xlsx")
    require(len(monthly["Pay Periods"][0]) == 2 and len(weekly["Pay Periods"][0]) == 8,
            "Monthly and Weekly export rows must match the selected pay-period type")
    require(one(monthly["Monthly Summary"][0], Month="2026-01")["Realistic Remaining"]
            == Decimal("1635.35")
            and one(weekly["Monthly Summary"][0], Month="2026-01")["Realistic Remaining"]
            == Decimal("1635.35"),
            "Changing export section count must not lose monthly money")

    january_headers = [date_header("January", 2026, 1, 14), date_header("January", 2026, 15, 31)]
    overview = without_notes["CY26 Data"]
    validate_overview(overview, january_headers, actual_blocks=(0, 1))
    validate_overview(with_notes["CY26 Data"], january_headers, actual_blocks=(0, 1))
    expected_overview = {"A3": "1200", "B3": "1000.10", "B4": "25.50", "B5": "10",
                         "A7": "-125", "B7": "-100.20", "A13": "-25", "B13": "-20.20",
                         "A14": "-200", "B14": "-100", "A18": "-350", "B18": "-220.40",
                         "A19": "850", "B19": "815.20", "E3": "1000", "F3": "900.90",
                         "F11": "-30.50", "E14": "-100", "F14": "-50.25",
                         "E18": "-150", "F18": "-80.75", "E19": "850", "F19": "820.15"}
    for reference, amount in expected_overview.items():
        require(overview_value(overview, reference) == Decimal(amount),
                f"Incorrect calendar-year amount or spending sign at {reference}")
    require(overview_value(overview, "A12") is None and overview_value(overview, "E12") == Decimal(0),
            "Overview must preserve blank expenses versus an explicitly entered zero")
    require(overview_value(overview, "E5") is None and overview_value(overview, "F5") is None,
            "A prior period's remaining balance must not become a fabricated savings withdrawal")
    require(overview_value(overview, "B19") + overview_value(overview, "F19")
            == summary["Realistic Remaining"], "Overview period totals must compile to the monthly result")

    february_headers = [date_header("February", 2026, 1, 14), date_header("February", 2026, 15, 28)]
    validate_overview(empty["CY26 Data"], february_headers)
    explicit_zero, _ = read_workbook(directory / "explicit-zero.xlsx")
    validate_overview(explicit_zero["CY26 Data"], february_headers, actual_blocks=(0,))
    require(overview_value(empty["CY26 Data"], "B3") is None
            and overview_value(explicit_zero["CY26 Data"], "B3") == Decimal(0),
            "Explicit zero income must stay distinguishable from an untouched Actual period")
    require(overview_value(empty["CY26 Data"], "A19") == Decimal(0)
            and overview_value(empty["CY26 Data"], "B19") == Decimal(0),
            "Derived remaining totals must stay zero without coloring untouched plans")
    validate_overview(monthly["CY26 Data"], [date_header("January", 2026, 1, 31, 10)], actual_blocks=(0,))
    validate_overview(weekly["CY26 Data"], [date_header("January", 2026, 1, 7, 1),
                                           date_header("January", 2026, 8, 14, 8),
                                           date_header("January", 2026, 15, 21, 15),
                                           date_header("January", 2026, 22, 31, 22)], actual_blocks=(0, 1))

    distinct, _ = read_workbook(directory / "distinct-period.xlsx")
    distinct_overview = distinct["CY26 Data"]
    validate_overview(distinct_overview, january_headers, actual_blocks=(0, 1))
    require(overview_value(distinct_overview, "A19") == Decimal(850)
            and overview_value(distinct_overview, "E19") == Decimal(650)
            and overview_value(distinct_overview, "F19") == Decimal("820.15"),
            "Different projected period totals must remain independent comparison targets")
    require(overview_value(distinct_overview, "B19") < overview_value(distinct_overview, "A19")
            and overview_value(distinct_overview, "F19") >= overview_value(distinct_overview, "E19")
            and overview_value(distinct_overview, "F19") < overview_value(distinct_overview, "A19"),
            "The synthetic second period must require green despite falling below the first period's plan")

    multiple_months, _ = read_workbook(directory / "multiple-months.xlsx")
    validate_overview(multiple_months["CY26 Data"], january_headers + february_headers, actual_blocks=(0, 1))
    require(len(multiple_months["Monthly Summary"][0]) == 2
            and len(multiple_months["Pay Periods"][0]) == 8,
            "Two selected months must appear once each, without fabricating missing months")
    require(overview_value(multiple_months["CY26 Data"], "J5") == Decimal(3)
            and overview_value(multiple_months["CY26 Data"], "N5") is None
            and overview_value(multiple_months["CY26 Data"], "J19") == Decimal(68)
            and overview_value(multiple_months["CY26 Data"], "N19") == Decimal(86),
            "Savings withdrawals must reflect entered records, with no cross-month carryover")

    multiple_years, _ = read_workbook(directory / "multiple-years.xlsx")
    require(list(multiple_years)[:2] == ["CY25 Data", "CY26 Data"],
            "Selected years must get separate chronological overview sheets")
    validate_overview(multiple_years["CY25 Data"], [date_header("December", 2025, 1, 14),
                                                   date_header("December", 2025, 15, 31)], actual_blocks=(0,))
    validate_overview(multiple_years["CY26 Data"], january_headers, actual_blocks=(0, 1))
    require(overview_value(multiple_years["CY25 Data"], "A19") == Decimal(42)
            and overview_value(multiple_years["CY25 Data"], "B19") == Decimal("38.75"),
            "Prior-year amounts must not be fabricated from current-year periods")

    unknown, _ = read_workbook(directory / "unknown-category.xlsx")
    unknown_overview = unknown["CY26 Data"]
    validate_overview(unknown_overview, january_headers, extra_categories=("Parking",), actual_blocks=(0, 1))
    require(overview_value(unknown_overview, "A18") == Decimal("-7.50")
            and overview_value(unknown_overview, "B18") == Decimal("-2.75")
            and overview_value(unknown_overview, "A19") == Decimal("-357.50")
            and overview_value(unknown_overview, "B19") == Decimal("-223.15")
            and overview_value(unknown_overview, "A20") == Decimal("842.50")
            and overview_value(unknown_overview, "B20") == Decimal("812.45"),
            "Additional expense categories must remain in overview rows and exact totals")
    detail_parking = one(unknown["Categories"][0], Month="2026-01", Period=Decimal(1),
                         Plan="Realistic", Category="Parking")
    require(detail_parking["Manual Amount"] == Decimal("2.50")
            and detail_parking["Logged Amount"] == Decimal("0.25")
            and detail_parking["Total Amount"] == Decimal("2.75"),
            "Expense signs change only in the overview; detail tables keep positive source amounts")
    funded_buckets, raw_buckets = read_workbook(directory / "funded-bucket.xlsx", expects_buckets=True)
    require(list(funded_buckets)[-1] == "Savings Buckets",
            "Selected funded bucket detail must be the last worksheet")
    bucket_rows, _ = funded_buckets["Savings Buckets"]
    require(len(bucket_rows) == 2, "Only the two entered plan rows should appear as bucket funding")
    projected_bucket = one(bucket_rows, Month="2026-01", Period=Decimal(1), Plan="Budgeted")
    actual_bucket = one(bucket_rows, Month="2026-01", Period=Decimal(1), Plan="Realistic")
    expected_name = '=HYPERLINK("x","BUCKET-LITERAL-NAME & <😀>")'
    for row in (projected_bucket, actual_bucket):
        require(row["Bucket"] == expected_name and row["Start Day"] == Decimal(1)
                and row["End Day"] == Decimal(14),
                "Bucket name snapshots must remain literal text in their recorded pay period")
    require(projected_bucket["Contribution"] == Decimal(40)
            and projected_bucket["Withdrawal"] == Decimal(3)
            and projected_bucket["NetContribution"] == Decimal(37)
            and actual_bucket["Contribution"] == Decimal(25)
            and actual_bucket["Withdrawal"] == Decimal(5)
            and actual_bucket["NetContribution"] == Decimal(20),
            "Bucket table must distinguish planned and realistic funding without combining their totals")
    require(b"11111111-2222-3333-4444-555555555555" not in raw_buckets,
            "Bucket internal identifiers must never appear in an exported report")
    require("Notes" not in funded_buckets["Transactions"][1]
            and b"PRIVATE-NOTE-TEST" not in raw_buckets,
            "Adding bucket exports must not opt transaction notes into the report")
    bucket_summary = one(funded_buckets["Monthly Summary"][0], Month="2026-01")
    expected_bucket_summary = {"Budgeted Savings Deposits": "340", "Budgeted Savings Withdrawals": "3",
                               "Budgeted Remaining": "1663", "Savings Deposits": "175.25",
                               "Savings Withdrawals": "15", "Savings Change": "160.25",
                               "Realistic Remaining": "1615.35", "Realistic Expenses": "150.90",
                               "Expense Budget Remaining": "49.10"}
    for label, amount in expected_bucket_summary.items():
        require(bucket_summary[label] == Decimal(amount), f"Bucket accounting changed {label}")
    bucket_periods = funded_buckets["Pay Periods"][0]
    actual_period = one(bucket_periods, Month="2026-01", Period=Decimal(1), Plan="Realistic")
    projected_period = one(bucket_periods, Month="2026-01", Period=Decimal(1), Plan="Budgeted")
    require(actual_period["Savings Deposits"] == Decimal(125)
            and actual_period["Savings Withdrawals"] == Decimal(15)
            and actual_period["Remaining"] == Decimal("795.20")
            and actual_period["Payroll"] == Decimal("1000.10")
            and actual_period["Extra"] == Decimal("25.50"),
            "General savings and bucket funding must aggregate once without changing income")
    require(projected_period["Savings Deposits"] == Decimal(240)
            and projected_period["Savings Withdrawals"] == Decimal(3)
            and projected_period["Remaining"] == Decimal(813),
            "Projected bucket funding must remain separate from Realistic funding")
    bucket_overview = funded_buckets["CY26 Data"]
    validate_overview(bucket_overview, january_headers, actual_blocks=(0, 1))
    expected_bucket_cells = {"A5": "3", "B5": "15", "A14": "-240", "B14": "-125",
                             "A18": "-390", "B18": "-245.40", "A19": "813", "B19": "795.20"}
    for reference, amount in expected_bucket_cells.items():
        require(overview_value(bucket_overview, reference) == Decimal(amount),
                f"CY savings row must aggregate general and bucket amounts exactly once at {reference}")

    blank_buckets, raw_blank_buckets = read_workbook(directory / "blank-bucket.xlsx")
    validate_overview(blank_buckets["CY26 Data"], february_headers)
    require("Savings Buckets" not in blank_buckets
            and b"EMPTY-BUCKET-NAME-SHOULD-NOT-EXPORT" not in raw_blank_buckets,
            "Blank-only bucket entries must not expose unused names or create an extra sheet")
    zero_buckets, _ = read_workbook(directory / "zero-bucket.xlsx", expects_buckets=True)
    validate_overview(zero_buckets["CY26 Data"], february_headers, actual_blocks=(0,))
    zero_rows = zero_buckets["Savings Buckets"][0]
    require(len(zero_rows) == 2 and all(row["Contribution"] == Decimal(0)
                                      and row["Withdrawal"] is None
                                      and row["NetContribution"] == Decimal(0) for row in zero_rows),
            "An explicitly entered zero bucket contribution must preserve a blank withdrawal")
    require(overview_value(zero_buckets["CY26 Data"], "B14") == Decimal(0)
            and overview_value(zero_buckets["CY26 Data"], "B5") is None,
            "Bucket-only zero contributions must count as input without inventing withdrawals")

    withdrawal_buckets, _ = read_workbook(directory / "withdrawal-only-bucket.xlsx", expects_buckets=True)
    validate_overview(withdrawal_buckets["CY26 Data"], february_headers, actual_blocks=(0,))
    withdrawal_row = one(withdrawal_buckets["Savings Buckets"][0], Month="2026-02",
                         Period=Decimal(1), Plan="Realistic")
    require(withdrawal_row["Contribution"] is None and withdrawal_row["Withdrawal"] == Decimal(5)
            and withdrawal_row["NetContribution"] == Decimal(-5),
            "Withdrawal-only bucket records must retain their missing contribution")
    withdrawal_period = one(withdrawal_buckets["Pay Periods"][0], Month="2026-02",
                            Period=Decimal(1), Plan="Realistic")
    require(withdrawal_period["Savings Deposits"] is None
            and withdrawal_period["Savings Withdrawals"] == Decimal(5)
            and withdrawal_period["Remaining"] == Decimal(5)
            and overview_value(withdrawal_buckets["CY26 Data"], "B14") is None
            and overview_value(withdrawal_buckets["CY26 Data"], "B5") == Decimal(5)
            and overview_value(withdrawal_buckets["CY26 Data"], "B19") == Decimal(5),
            "Bucket withdrawal increases available cash once without fabricating a savings deposit")
    selected_no_buckets, raw_selected_no_buckets = read_workbook(directory / "selected-no-buckets.xlsx")
    validate_overview(selected_no_buckets["CY26 Data"], january_headers, actual_blocks=(0, 1))
    require("Savings Buckets" not in selected_no_buckets
            and b"OUTSIDE-BUCKET-DO-NOT-EXPORT" not in raw_selected_no_buckets
            and b"444444.44" not in raw_selected_no_buckets
            and b"ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB" not in raw_selected_no_buckets,
            "Buckets outside the selected months must not create sheets, expose names, IDs, or funding")
    print("PASS: Fifteen native Excel packages validated independently with ZIP/XML/Decimal/layout/bucket checks")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: check-excel-package.py TEMPORARY_TEST_DIRECTORY")
    validate(Path(sys.argv[1]))
