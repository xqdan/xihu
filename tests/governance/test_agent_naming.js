'use strict';
/* Guards the agent naming contract from 20_INDUSTRIAL_AGENT_ORGANIZATION.md §3
 * (<TEAM>-<编号>-<职责>): every id is team-prefixed with a two-digit index, ids
 * are globally unique, flow edges only reference known agents, and the contract
 * generator's requiredAgents stays in sync with the roster and the published
 * manifest. Without that last check, adding an agent to the roster silently
 * leaves out/contracts/ stale. */
const assert=require('assert');const fs=require('fs');const path=require('path');
const root=path.resolve(__dirname,'../..');
const catalog=JSON.parse(fs.readFileSync(path.join(root,'teams/council/inputs/industrial_agent_organization.json'),'utf8'));
const roster=Object.values(catalog.teams).flatMap(t=>t.agents.map(a=>a.id));
const governance=[...catalog.governance.architectureCouncil.agents,...catalog.governance.verification.agents];
const all=[...roster,...governance];
// <TEAM>-<编号>: the prefix carries ownership, the index carries the seat.
for(const id of all){
  assert(/^(HW|SW|MODEL|ARCH|VV)-\d{2}$/.test(id),`agent id must be <TEAM>-<NN>: ${id}`);
}
assert.strictEqual(new Set(all).size,all.length,'agent ids must be globally unique');
// The team directory a roster agent lives in must match its id prefix.
const PREFIX={hardware:'HW',software:'SW',model:'MODEL'};
for(const [team,body] of Object.entries(catalog.teams)) for(const agent of body.agents){
  assert(agent.id.startsWith(`${PREFIX[team]}-`),`${agent.id} is listed under ${team}`);
}
// Every id referenced in the flow edges must exist in the roster (the reverse is
// not required: the flow diagram is a summary, not an exhaustive listing).
for(const [name,edge] of Object.entries(catalog.flow)){
  for(const id of edge.match(/(?:HW|SW|MODEL|ARCH|VV)-\d{2}/g)||[]){
    assert(all.includes(id),`flow.${name} references unknown agent ${id}`);
  }
}
const gen=fs.readFileSync(path.join(root,'integration/pipelines/generate_team_contracts.js'),'utf8');
const declared=JSON.parse(gen.match(/requiredAgents:(\[[^\]]*\])/)[1].replace(/'/g,'"'));
assert.deepStrictEqual(declared.slice().sort(),roster.slice().sort(),'generate_team_contracts.js requiredAgents must equal the HW/SW/MODEL roster exactly');
const integration=JSON.parse(fs.readFileSync(path.join(root,'out/contracts/integration_manifest.json'),'utf8'));
assert.deepStrictEqual(integration.requiredAgents.slice().sort(),declared.slice().sort(),'out/contracts/integration_manifest.json is stale; re-run the contract generator');
console.log('PASS agent naming: <TEAM>-<NN> namespace, unique ids, in-sync generator and published manifest');
