// Builds the two bundles from apps-script/api. No Sheet ID or secret is ever written here.
//   node tools/bundle.js > Code.gs        the whole API as one file to paste into Apps Script (type the Sheet ID into the pasted copy only)
//   node tools/bundle.js --core > docs/core.js   the sums the phone runs itself (Logic.gs + Core.gs), exposed as window.HanaroCore
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '../apps-script/api');
const read = (f) => '// ===== ' + f + ' =====\n' + fs.readFileSync(path.join(dir, f), 'utf8');
if (process.argv.includes('--core')) {
  process.stdout.write('/* Built by tools/bundle.js --core from Logic.gs and Core.gs. Do not edit by hand. */\n(function (root) {\n  "use strict";\n' +
    '  var scope = {};\n' +
    '  var src = ' + JSON.stringify(read('Logic.gs') + '\nvar __logicExports = module.exports;\n' + read('Core.gs')) + ';\n' +
    '  var m = { exports: {} };\n' +
    '  root.HanaroCore = (new Function("module", src + "\\n;return Object.assign({}, __logicExports, module.exports);"))(m);\n})(typeof window !== "undefined" ? window : this);\n');
} else {
  process.stdout.write(['Logic.gs', 'Core.gs', 'Api.gs', 'YnabImport.gs'].map(read).join('\n'));
}
