process.chdir(require('path').resolve(__dirname,'../..')); // paths below are relative to the repository root
const fs=require('fs');
const org=JSON.parse(fs.readFileSync('teams/council/inputs/industrial_agent_organization.json','utf8'));
const teamMeta={hardware:{name:'Hardware Team',mission:'定义可实现的 7-reticle 单芯片硬件规格和资源边界',goal:'在面积、带宽、算力、通信、功耗和热约束下形成可制造候选'},software:{name:'Software Team',mission:'将模型部署到硬件并通过编译、算子、融合、通信 overlap 和调度提升有效吞吐',goal:'把每项软件收益转化为可执行、可回放、可回滚的 schedule'},model:{name:'Model Team',mission:'维护三模型真实性、工作负载、场景和测试验收',goal:'让每个硬件/软件结论都有明确 model、shape、dtype、routing 和测试范围'}};
const special={
'ARCH-01':['Architecture Council','发布统一目标、约束、证据等级和版本基线'],
'ARCH-02':['Architecture Council','集成三团队结果，生成候选架构和方向级 TPS/PPA envelope'],
'ARCH-03':['Architecture Council','管理详细协同设计、backflow 和跨团队决策'],
'VV-01':['V&V','验证跨团队 schema、单位、版本和 provenance'],
'VV-02':['V&V','验证事件、时序、守恒和 18-slot coverage'],
'VV-03':['V&V','独立执行 D-Gate/Q-Gate 和 regression']};
const details={};
for(const [id,[team,goal]] of Object.entries(special)) details[id]={team,goal,inputs:['已发布的上游 contract/artifact','模型/硬件/软件版本和假设'],outputs:['architecture or verification report','machine-readable artifact','review and handoff'],constraints:['不得越权替代专业团队','关键结果必须带版本/hash','不得把规划估算当 validated observation']};
for(const [key,t] of Object.entries(org.teams)) for(const a of t.agents){details[a.id]={team:teamMeta[key].name,role:a.role,goal:teamMeta[key].goal,teamMission:teamMeta[key].mission,inputs:['已发布的上游 contract/artifact','模型/硬件/软件版本和假设'],outputs:[`${a.role} design specification`,`${a.id} machine-readable artifact`,'review and handoff report'],constraints:['one owner per file','输入必须有版本/hash','planning estimate 不得冒充 validated observation'],legacy:a.legacy};}
const flow=[{from:'ARCH-01',to:['MODEL-01','HW-01'],label:'requirements / constraints'},{from:['MODEL-01','MODEL-02','MODEL-03'],to:['HW-02','HW-03','HW-04','HW-05','SW-01','SW-02'],label:'model workload contract'},{from:['HW-*','MODEL-*'],to:['SW-*'],label:'hardware/model feasibility contracts'},{from:['HW-*','SW-*','MODEL-*'],to:'ARCH-02',label:'candidate integration'},{from:'ARCH-02',to:'VV-01',label:'D-Gate evidence review'},{from:'ARCH-03',to:'VV-02',label:'timing / conservation review'},{from:['VV-01','VV-02'],to:'VV-03',label:'independent Gate'}];
const out={schemaVersion:'agent-org-detail-v0.1',asOf:'2026-09-22',organization:org,teamMeta,agentDetails:details,flow,evidenceStates:[['UNVERIFIED_PLANNING_MANIFEST','模型/配置规划输入，未供应商确认'],['SYNTHETIC_BOTTLENECK_BOUND','合成规划上界，不是事件时序结果'],['VALIDATED_EVENT_TIMING','由独立可回放 trace 支撑的时序结果'],['SILICON_OBSERVED','真实芯片观测结果']]};
fs.writeFileSync('out/agents/industrial_agent_detail.json',JSON.stringify(out,null,2)+'\n');
