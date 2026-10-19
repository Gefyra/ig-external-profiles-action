// Simplifier syntax is replaced by plain text. Cases are taken from ISiK Stufe 5 (de.gematik.isik#5.1.1).
// Run: node test/simplifier.test.js

'use strict';

const assert = require('assert');
const { stripSimplifierSyntax } = require('../bin/ig-external-profiles.js');

const cases = [
  ['siehe {{pagelink:Patient-merge}} befüllt', 'siehe Patient-merge befüllt', 1],
  ['finden sie unter {{pagelink: Fall, text: Fall-Begriff in ISiK}}', 'finden sie unter Fall-Begriff in ISiK', 1],
  ['{{pagelink:Dokumentenabfrage, text:Dokumentenabfrage}}', 'Dokumentenabfrage', 1],
  ['{{pagelink: Dokumentenbereitstellung}}', 'Dokumentenbereitstellung', 1],
  ['{{pagelink:Dokumentenbereitstellung text:Interaktion:Dokumentenbereitstellung > Option 5}}',
    'Interaktion:Dokumentenbereitstellung > Option 5', 1],
  ['{{link: ISiK/Fall.md}}', 'Fall', 1],
  ['vorher {{tree:https://gematik.de/fhir/isik/StructureDefinition/ISiKPatient}} nachher', 'vorher  nachher', 1],
  // Liquid output and plain braces stay untouched
  ['{{ extern_desc | markdownify }}', '{{ extern_desc | markdownify }}', 0],
  ['{{title}}', '{{title}}', 0],
  [undefined, '', 0],
];

for (const [input, text, count] of cases) {
  assert.deepStrictEqual(stripSimplifierSyntax(input), { text, count }, `input: ${input}`);
}
console.log(`simplifier: ${cases.length} cases passed`);
