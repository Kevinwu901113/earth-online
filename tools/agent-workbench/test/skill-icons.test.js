import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {skillIconCatalog,skillIcons} from '../public/skill-icons.js';
import {personalNodeSchema,addedNodeSchema} from '../tree-patch.js';
test('every semantic icon resolves to a bundled Lucide asset and an accepted schema value',()=>{
 const ctx={};vm.runInNewContext(readFileSync(new URL('../public/tree-icons.js',import.meta.url),'utf8'),ctx);
 assert.equal(new Set(skillIconCatalog.map(i=>i.key)).size,skillIconCatalog.length);
 for(const icon of skillIconCatalog){const name=icon.glyph.split('-').map(s=>s[0].toUpperCase()+s.slice(1)).join('');assert.ok(ctx.lucide.icons[name],icon.key);assert.equal(skillIcons[icon.key],icon.glyph);assert.equal(personalNodeSchema.shape.icon.parse(icon.key),icon.key);if(!['core','milestone'].includes(icon.key))assert.equal(addedNodeSchema.shape.icon.parse(icon.key),icon.key)}
});
