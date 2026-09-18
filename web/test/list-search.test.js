import test from 'node:test';
import assert from 'node:assert/strict';
import { listSearch, matchesSearch } from '../src/shared/list-search.js';
import { lifetime } from '../src/shared/dom.js';
import { brandMarkup } from '../src/shared/brand.js';

test('list search trims, matches case-insensitively and treats percent literally', () => {
 assert.equal(matchesSearch(' PHY ', 'Physics'),true);
 assert.equal(matchesSearch('物理','大学物理（2）'),true);
 assert.equal(matchesSearch('106',106621772),true);
 assert.equal(matchesSearch('%','any course'),false);
 assert.equal(matchesSearch('',null),true);
});
test('list search keeps input drafts across render and clears applied search', () => {
 const listeners=new Map(),life=lifetime();
 const host={addEventListener:(type,fn)=>listeners.set(type,[...(listeners.get(type)||[]),fn]),removeEventListener:(type,fn)=>listeners.set(type,listeners.get(type).filter(v=>v!==fn)),contains:()=>true};
 let query=''; const search=listSearch(host,life,'s','搜索',(value)=>{query=value;});
 const input={value:'Physics & <2>'};
 for(const fn of listeners.get('input'))fn({target:{closest:()=>input}});
 assert.match(search.markup(),/value="Physics &amp; &lt;2&gt;"/);
 const clear={};for(const fn of listeners.get('click'))fn({target:{closest:()=>clear}});
 assert.equal(query,'');assert.match(search.markup(),/value=""/);
 life.dispose();assert.equal([...listeners.values()].flat().length,0);
});
test('CCF mark uses three pixel glyphs and accessible brand name', () => {
 const html=brandMarkup(); assert.match(html,/aria-label="CCF"/);
 for(let i=0;i<3;i++)assert.match(html,new RegExp(`brand-letter-${i}`));
 assert.match(html,/shape-rendering="crispEdges"/);assert.match(html,/pixel-brand-cursor/);
});
