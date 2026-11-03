"""Inspect only temporary synthetic workbooks from the Node test harness."""
from pathlib import Path, PurePosixPath
import json
import posixpath
import sys
import xml.etree.ElementTree as ET
import zipfile

M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
P = 'http://schemas.openxmlformats.org/package/2006/relationships'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
NS = {'m': M, 'p': P}


def require(ok, message):
    if not ok:
        raise AssertionError(message)


def inspect(path):
    with zipfile.ZipFile(path) as archive:
        require(archive.testzip() is None, 'ZIP CRC validation failed')
        names = archive.namelist()
        require(len(names) == len(set(names)), 'Duplicate ZIP path')
        require(all(not PurePosixPath(n).is_absolute() and '..' not in PurePosixPath(n).parts
                    for n in names), 'Unsafe package path')
        require(all(n.endswith(('.xml', '.rels')) for n in names), 'Unexpected binary part')
        roots = {n: ET.fromstring(archive.read(n)) for n in names}
        for name, root in roots.items():
            require(root.find('.//m:f', NS) is None, 'Executable cell formula')
            require(root.find('.//m:externalReference', NS) is None, 'External workbook reference')
            if name.endswith('.rels'):
                base = '' if name == '_rels/.rels' else str(PurePosixPath(name).parent.parent)
                for rel in root.findall('p:Relationship', NS):
                    require(rel.get('TargetMode') != 'External', 'External relationship')
                    target = rel.attrib['Target']
                    resolved = target.lstrip('/') if target.startswith('/') else posixpath.normpath(
                        posixpath.join(base, target))
                    require(resolved in roots, 'Unresolved relationship')
        wb = roots['xl/workbook.xml']
        rels = {r.attrib['Id']: r.attrib['Target'] for r in
                roots['xl/_rels/workbook.xml.rels'].findall('p:Relationship', NS)}
        styles = roots['xl/styles.xml']
        style_defs = styles.findall('m:cellXfs/m:xf', NS)
        fonts = styles.findall('m:fonts/m:font', NS)
        fills = styles.findall('m:fills/m:fill', NS)
        result = {'sheetNames': [], 'sheets': {}}
        for sheet in wb.findall('m:sheets/m:sheet', NS):
            name = sheet.attrib['name']
            result['sheetNames'].append(name)
            target = rels[sheet.attrib['{' + R + '}id']]
            root = roots['xl/' + target]
            cells = {}
            for cell in root.findall('m:sheetData/m:row/m:c', NS):
                ref = cell.attrib['r']
                require(ref not in cells, 'Duplicate cell reference')
                style_id = int(cell.get('s', '0'))
                require(0 <= style_id < len(style_defs), 'Invalid cell style')
                value = ''.join(cell.find('m:is', NS).itertext()) if cell.get('t') == 'inlineStr' else cell.findtext('m:v', None, NS)
                cells[ref] = value
            comparisons = {}
            for cf in root.findall('m:conditionalFormatting', NS):
                comparisons[cf.attrib['sqref']] = [r.findtext('m:formula', None, NS)
                                                    for r in cf.findall('m:cfRule', NS)]
            item = {
                'cells': cells,
                'merges': [m.attrib['ref'] for m in root.findall('m:mergeCells/m:mergeCell', NS)],
                'widths': [float(c.attrib['width']) for c in root.findall('m:cols/m:col', NS)],
                'comparisons': comparisons,
            }
            if name.startswith('CY'):
                require(len(style_defs) >= 7, 'Missing CY style definitions')
                money = style_defs[4]
                font = fonts[int(money.attrib['fontId'])]
                require(font.find('m:name', NS).get('val') == 'Calibri', 'Wrong CY font')
                require(font.find('m:sz', NS).get('val') == '12', 'Wrong CY font size')
                require(money.get('numFmtId') == '2', 'CY numeric format must be 0.00')
                require(money.find('m:alignment', NS).get('horizontal') == 'center', 'Wrong alignment')
                header = style_defs[5]
                fill = fills[int(header.attrib['fillId'])].find('m:patternFill/m:fgColor', NS)
                require(fill.get('rgb') == 'FFFFF2CC', 'Wrong CY header fill')
                pane = root.find('m:sheetViews/m:sheetView/m:pane', NS)
                require(pane is not None and pane.get('ySplit') == '2', 'CY headings must remain frozen')
            result['sheets'][name] = item
        return result


if __name__ == '__main__':
    print(json.dumps(inspect(Path(sys.argv[1]))))
