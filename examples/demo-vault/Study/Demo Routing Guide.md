# Demo Routing Guide

Tells Claude Notebook where to file dropped documents. Each line is `keyword1, keyword2: folder-name` — if a document matches any keyword, it lands in that folder. Point the plugin's **routing-guide** setting at this file.

```
lecture, tutorial, slides: 20-study
invoice, receipt, statement: 10-finance
dataset, csv, spreadsheet: 50-reference
timetable, ics, calendar: 30-calendar
```
