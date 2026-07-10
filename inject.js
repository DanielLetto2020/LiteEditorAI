const fs = require('fs');
const js = fs.readFileSync('renderer/modules/textproc.js', 'utf8');
const tabsCode = fs.readFileSync('/Users/Ainour108/.gemini/antigravity/brain/93ab86e3-cd51-4e21-b3dc-82d141f88e13/scratch/textproc-tabs.js', 'utf8');
const target = '  return {\n    isOpen: () => docOpen,';
const replacement = tabsCode + '\n  return {\n    renderTree,\n    onFsChange,\n    isOpen: () => docOpen,';
fs.writeFileSync('renderer/modules/textproc.js', js.replace(target, replacement));
