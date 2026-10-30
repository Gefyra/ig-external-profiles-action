// Markdown links to canonical URLs in element texts are resolved through Simplifier.
// Case taken from ISiK Stufe 5 (de.gematik.isik#5.2.0, ISiKProzedur, Procedure.category).
// Run: node test/links.test.js

'use strict';

const assert = require('assert');
const { rewriteResourceTexts } = require('../bin/ig-external-profiles.js');

const comment = 'mit Hilfe einer [ConceptMap](http://fhir.de/ConceptMap/OPS-SNOMED-Category) auf die';
const res = {
  differential: { element: [{ id: 'Procedure.category', comment }] },
  snapshot: { element: [
    { id: 'Procedure.category', comment, binding: { description: 'see [page](https://example.org/page.html)' } },
    { id: 'Procedure.code', definition: 'no link' },
  ] },
};

assert.strictEqual(rewriteResourceTexts(res), 2);
const expected = 'mit Hilfe einer [ConceptMap](https://simplifier.net/resolve?canonical='
  + encodeURIComponent('http://fhir.de/ConceptMap/OPS-SNOMED-Category') + ') auf die';
assert.strictEqual(res.differential.element[0].comment, expected);
assert.strictEqual(res.snapshot.element[0].comment, expected);
// Links to web pages and texts without links stay untouched
assert.strictEqual(res.snapshot.element[0].binding.description, 'see [page](https://example.org/page.html)');
assert.strictEqual(res.snapshot.element[1].definition, 'no link');
assert.strictEqual(rewriteResourceTexts({}), 0);
console.log('links: passed');
