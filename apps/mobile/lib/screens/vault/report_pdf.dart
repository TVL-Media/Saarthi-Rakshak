import 'dart:io';

import 'package:path_provider/path_provider.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;

/// One row of a PDF report.
class ReportRow {
  ReportRow(this.title, this.lines);
  final String title;
  final List<String> lines;
}

const _red = PdfColor.fromInt(0xFFEE1D23);
const _muted = PdfColor.fromInt(0xFF6B7280);

/// A plain A4 report (incident report, daily location report). Returns the file path (private
/// cache; the caller encrypts it into the vault and/or shares it).
Future<String> buildReportPdf({
  required String fileName,
  required String title,
  required List<String> intro,
  required List<ReportRow> rows,
  List<String> footer = const [],
}) async {
  final doc = pw.Document(title: title, author: 'Sarthi Rakshak');
  doc.addPage(
    pw.MultiPage(
      pageFormat: PdfPageFormat.a4,
      margin: const pw.EdgeInsets.fromLTRB(40, 40, 40, 40),
      header: (ctx) => pw.Container(
        padding: const pw.EdgeInsets.only(bottom: 8),
        decoration: const pw.BoxDecoration(border: pw.Border(bottom: pw.BorderSide(color: _red, width: 2))),
        child: pw.Row(mainAxisAlignment: pw.MainAxisAlignment.spaceBetween, children: [
          pw.Text('Sarthi Rakshak', style: pw.TextStyle(color: _red, fontWeight: pw.FontWeight.bold, fontSize: 14)),
          pw.Text('Page ${ctx.pageNumber} of ${ctx.pagesCount}', style: const pw.TextStyle(color: _muted, fontSize: 9)),
        ]),
      ),
      build: (ctx) => [
        pw.SizedBox(height: 12),
        pw.Text(title, style: pw.TextStyle(fontSize: 20, fontWeight: pw.FontWeight.bold)),
        pw.SizedBox(height: 8),
        for (final l in intro) pw.Padding(padding: const pw.EdgeInsets.only(bottom: 3), child: pw.Text(l, style: const pw.TextStyle(fontSize: 11))),
        pw.SizedBox(height: 14),
        for (final (i, r) in rows.indexed)
          pw.Container(
            margin: const pw.EdgeInsets.only(bottom: 8),
            padding: const pw.EdgeInsets.all(10),
            decoration: pw.BoxDecoration(
              border: pw.Border.all(color: const PdfColor.fromInt(0xFFE7E2DC)),
              borderRadius: const pw.BorderRadius.all(pw.Radius.circular(6)),
            ),
            child: pw.Column(crossAxisAlignment: pw.CrossAxisAlignment.start, children: [
              pw.Text('${i + 1}. ${r.title}', style: pw.TextStyle(fontWeight: pw.FontWeight.bold, fontSize: 12)),
              pw.SizedBox(height: 4),
              for (final l in r.lines) pw.Text(l, style: const pw.TextStyle(fontSize: 9.5)),
            ]),
          ),
        if (footer.isNotEmpty) ...[
          pw.SizedBox(height: 12),
          for (final l in footer) pw.Text(l, style: const pw.TextStyle(color: _muted, fontSize: 9)),
        ],
      ],
    ),
  );
  final dir = Directory('${(await getTemporaryDirectory()).path}/vault');
  if (!dir.existsSync()) dir.createSync(recursive: true);
  final file = File('${dir.path}/$fileName');
  await file.writeAsBytes(await doc.save());
  return file.path;
}
