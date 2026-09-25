'use strict';
const assert=require('assert');const fs=require('fs');const path=require('path');
const root=path.resolve(__dirname, '../..');
const doc=fs.readFileSync(path.join(root,'teams/council/docs/20_INDUSTRIAL_AGENT_ORGANIZATION.md'),'utf8');
const catalog=JSON.parse(fs.readFileSync(path.join(root,'teams/council/inputs/industrial_agent_organization.json'),'utf8'));
for(const name of ['hardware','software','model']) assert(fs.existsSync(path.join(root,'teams',name,'README.md')));
assert(doc.includes('Hardware Team')&&doc.includes('Software Team')&&doc.includes('Model Team'));
assert.deepStrictEqual(Object.keys(catalog.teams).sort(),['hardware','model','software']);
assert.strictEqual(catalog.teams.hardware.agents.length,6);
assert.strictEqual(catalog.teams.software.agents.length,7);
assert.strictEqual(catalog.teams.model.agents.length,6);
for(const team of Object.values(catalog.teams)) for(const agent of team.agents){assert(agent.id);assert(agent.role);assert(Array.isArray(agent.legacy));}
assert.strictEqual(catalog.rules.unverifiedModelNeverFrozen,true);
assert.strictEqual(catalog.rules.syntheticEventsNeverQGatePass,true);
assert.strictEqual(catalog.rules.softwareGainMustHaveImplementationPrecondition,true);
assert.strictEqual(catalog.governance.verification.independence,'independent of implementation teams');
console.log('PASS industrial team organization: Hardware/Software/Model rosters, ownership and independent V&V rules are defined');
