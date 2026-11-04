import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchSourceRecords} from '../scripts/sources.js';

for (const source of ['FTS','Contracts Finder']) {
  for (const [keyword,field] of [['organisational development','title'],['skills','description'],['workforce','item']]) {
    test(source+' admits '+keyword+' without a specialist CPV',async()=>{
      const tender={title:'Training programme',description:'Delivery of learning',classification:{id:'80000000'},status:'active',tenderPeriod:{endDate:'2099-12-01T12:00:00Z'}};
      if(field==='item')tender.items=[{description:'Support for WORKFORCE capability'}];
      else tender[field]='Provision of '+keyword.toUpperCase();
      const fixture={id:'fixture-'+keyword.replaceAll(' ','-'),date:'2026-11-04T10:00:00Z',tag:['tender'],buyer:{name:'Fixture council'},tender};
      const rows=await fetchSourceRecords(source,new Date('2026-11-01'),new Date('2026-11-04'),'fixture-build',{fetchImpl:async()=>Response.json({releases:[fixture]})});
      assert.equal(rows.length,1);
      assert.ok(rows[0].matchedKeywords.includes(keyword));
      assert.equal(rows[0].category,'Learning & development');
    });
  }
  test(source+' still excludes an unrelated broad CPV notice',async()=>{
    const rows=await fetchSourceRecords(source,new Date('2026-11-01'),new Date('2026-11-04'),'fixture-build',{fetchImpl:async()=>Response.json({releases:[{id:'unrelated',date:'2026-11-04',tag:['tender'],tender:{title:'School catering',classification:{id:'80000000'},tenderPeriod:{endDate:'2099-12-01'}}}]})});
    assert.equal(rows.length,0);
  });
}
