// Joins apps-script/api/Logic.gs, Api.gs and YnabImport.gs into one file for pasting into the Apps Script project.
// Usage: node tools/bundle.js > Code.gs   (the Sheet ID is typed into the pasted copy, never into this repo)
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '../apps-script/api');
const out = ['Logic.gs', 'Core.gs', 'Api.gs', 'YnabImport.gs'].map((f) => '// ===== ' + f + ' =====\n' + fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
process.stdout.write(out);
