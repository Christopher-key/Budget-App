#!/usr/bin/env python3
"""Independently validate synthetic workbooks produced by actual Swift exporter."""

from decimal import Decimal
from pathlib import Path, PurePosixPath
import posixpath
import sys
import xml.etree.ElementTree as ET
import zipfile


MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
DOCUMENT_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
CONTENT = "http://schemas.openxmlformats.org/package/2006/content-types"
NS = {"m": MAIN, "r": REL, "c": CONTENT}
SHEETS = ["Read Me", "Monthly Summary", "Pay Periods", "Categories", "Transactions"]


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


def read_workbook(path):
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
        require([sheet.attrib["name"] for sheet in sheets] == SHEETS,
                "Workbook must expose the five documented sheets in order")
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
            result[sheet.attrib["name"]] = rows_from_sheet(roots[package_name])
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
    print("PASS: Five native Excel packages validated independently with ZIP/XML/Decimal checks")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: check-excel-package.py TEMPORARY_TEST_DIRECTORY")
    validate(Path(sys.argv[1]))
