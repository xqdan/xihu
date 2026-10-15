#!/usr/bin/env node
/**
 * 端到端运行完整架构探索
 *
 * 用法:
 *   node scripts/run_exploration.js --backend codex --land
 *   node scripts/run_exploration.js --backend codex --land --start-from coupling
 *   node scripts/run_exploration.js --backend codex --land --stop-at converge
 *   node scripts/run_exploration.js --backend mock  # dry run
 */

const {execSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

// 解析命令行参数
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    backend: null,
    land: false,
    startFrom: null,
    stopAt: null,
    skipIfLanded: false,
    parallel: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--backend') {
      parsed.backend = args[++i];
    } else if (arg === '--land') {
      parsed.land = true;
    } else if (arg === '--start-from') {
      parsed.startFrom = args[++i];
    } else if (arg === '--stop-at') {
      parsed.stopAt = args[++i];
    } else if (arg === '--skip-if-landed') {
      parsed.skipIfLanded = true;
    } else if (arg === '--parallel') {
      parsed.parallel = true;
    } else if (arg === '-v' || arg === '--verbose') {
      parsed.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
用法: node scripts/run_exploration.js [选项]

选项:
  --backend <name>       后端: codex | claude | cursor | exchange | mock
  --land                 落盘产物(不加此项为 dry run)
  --start-from <stage>   从某个阶段开始(跳过前面)
  --stop-at <stage>      到某个阶段停止
  --skip-if-landed       跳过已有产物的 workflow
  --parallel             C 组五域并行运行(实验性)
  -v, --verbose          显示详细输出
  -h, --help             显示此帮助

阶段名:
  intake, req.workload, req.budget, arch.direction,
  compute, sram, mc, comm, physical,
  coupling, integrate, attribution, converge

示例:
  # 完整运行
  node scripts/run_exploration.js --backend codex --land

  # 从 coupling 继续
  node scripts/run_exploration.js --backend codex --land --start-from coupling

  # Dry run(不落盘)
  node scripts/run_exploration.js --backend mock
`);
      process.exit(0);
    }
  }

  if (!parsed.backend) {
    console.error('错误: 必须指定 --backend');
    process.exit(1);
  }

  return parsed;
}

// 执行命令
function run(cmd, opts = {}) {
  const {dryRun = false, ignoreError = false, verbose = false} = opts;

  if (verbose || dryRun) {
    console.log(`[${dryRun ? 'DRY RUN' : 'EXEC'}] ${cmd}`);
  }

  if (dryRun) return {ok: true, stdout: ''};

  try {
    const stdout = execSync(cmd, {
      cwd: REPO,
      encoding: 'utf-8',
      stdio: verbose ? 'inherit' : 'pipe',
    });
    return {ok: true, stdout};
  } catch (err) {
    if (ignoreError) {
      console.warn(`[WARN] 命令失败但继续: ${cmd}`);
      console.warn(err.message);
      return {ok: false, stdout: '', stderr: err.stderr?.toString() || err.message};
    }
    console.error(`[ERROR] 命令失败: ${cmd}`);
    console.error(err.message);
    if (err.stdout) console.error(err.stdout.toString());
    if (err.stderr) console.error(err.stderr.toString());
    process.exit(err.status || 1);
  }
}

// 检查文件是否存在
function exists(filePath) {
  return fs.existsSync(path.join(REPO, filePath));
}

// 检查产物是否新鲜
function isArtifactFresh(filePath, maxAgeHours = 24) {
  const fullPath = path.join(REPO, filePath);
  if (!fs.existsSync(fullPath)) return false;

  const stats = fs.statSync(fullPath);
  const ageMs = Date.now() - stats.mtimeMs;
  const ageHours = ageMs / (1000 * 60 * 60);

  return ageHours < maxAgeHours;
}

// 定义所有阶段
const STAGES = [
  // Phase 0 (可选)
  // {name: 'contract', phase: 'Phase 0', prep: null, workflow: 'design.contract'},

  // Phase A
  {name: 'intake', phase: 'Phase A', prep: null, workflow: 'design.intake', needsObjective: true},
  {name: 'req.workload', phase: 'Phase A', prep: 'npm run workload:requirements', workflow: 'design.req.workload', artifact: 'out/requirements/workload_requirements.json'},
  {name: 'req.budget', phase: 'Phase A', prep: 'npm run budget:frontier', workflow: 'design.req.budget', artifact: 'out/budget/budget_frontier.json'},

  // Phase B
  {name: 'arch.direction', phase: 'Phase B', prep: 'node integration/pipelines/stage_a.js && node integration/governance/evaluate_gates.js', workflow: 'design.arch.direction'},

  // Phase C (五域)
  {name: 'compute', phase: 'Phase C', prep: 'npm run aicore:search', workflow: 'design.compute', parallel: 'c-group'},
  {name: 'sram', phase: 'Phase C', prep: 'npm run sram:search', workflow: 'design.sram', parallel: 'c-group'},
  {name: 'mc', phase: 'Phase C', prep: 'npm run memory:search', workflow: 'design.mc', parallel: 'c-group'},
  {name: 'comm', phase: 'Phase C', prep: 'npm run commcore:search', workflow: 'design.comm', parallel: 'c-group'},
  {name: 'physical', phase: 'Phase C', prep: 'npm run physical:search', workflow: 'design.physical', parallel: 'c-group'},

  // Phase L3
  {name: 'coupling', phase: 'Phase L3', prep: 'npm run coupling:search', workflow: 'design.coupling', artifact: 'out/detailed/coupling_candidates.json'},

  // Phase D
  {name: 'integrate', phase: 'Phase D', prep: 'npm run model:planning', workflow: 'design.integrate'},

  // Phase L4 (可选)
  {name: 'attribution:sram', phase: 'Phase L4', prep: 'npm run attribution:cards', workflow: 'design.attribution', args: '--dimension sram', optional: true},
  {name: 'attribution:comm', phase: 'Phase L4', prep: null, workflow: 'design.attribution', args: '--dimension comm', optional: true},
  {name: 'attribution:joint', phase: 'Phase L4', prep: null, workflow: 'design.attribution', args: '--dimension joint', optional: true},

  // Phase L5
  {name: 'converge', phase: 'Phase L5', prep: 'node integration/governance/evaluate_gates.js', workflow: 'design.converge'},
];

// 主流程
function main() {
  const opts = parseArgs();

  console.log('='.repeat(80));
  console.log('端到端架构探索');
  console.log('='.repeat(80));
  console.log(`后端: ${opts.backend}`);
  console.log(`落盘: ${opts.land ? '是' : '否(dry run)'}`);
  if (opts.startFrom) console.log(`从 ${opts.startFrom} 开始`);
  if (opts.stopAt) console.log(`在 ${opts.stopAt} 停止`);
  console.log('='.repeat(80));
  console.log('');

  let started = !opts.startFrom;  // 如果没指定 start-from，从头开始
  let currentPhase = null;

  for (const stage of STAGES) {
    // 处理 start-from
    if (!started) {
      if (stage.name === opts.startFrom) {
        started = true;
        console.log(`\n>>> 从 ${stage.name} 开始\n`);
      } else {
        continue;
      }
    }

    // 处理 stop-at
    if (opts.stopAt && stage.name === opts.stopAt) {
      console.log(`\n>>> 在 ${stage.name} 之前停止\n`);
      break;
    }

    // 打印阶段头
    if (stage.phase !== currentPhase) {
      currentPhase = stage.phase;
      console.log('');
      console.log('━'.repeat(80));
      console.log(`  ${currentPhase}`);
      console.log('━'.repeat(80));
      console.log('');
    }

    console.log(`┌─ ${stage.name}`);

    // 检查是否跳过
    if (opts.skipIfLanded && stage.workflow) {
      const outputPath = `out/${stage.workflow.replace('design.', '').replace('.', '/')}_winner.json`;
      if (exists(outputPath)) {
        console.log(`│  [SKIP] 产物已存在: ${outputPath}`);
        console.log('└─ ✓ 跳过');
        console.log('');
        continue;
      }
    }

    // 1. 运行前置脚本
    if (stage.prep) {
      console.log(`│  [PREP] ${stage.prep}`);

      // 检查前置产物是否新鲜
      if (stage.artifact && opts.skipIfLanded && isArtifactFresh(stage.artifact, 24)) {
        console.log(`│         前置产物新鲜，跳过: ${stage.artifact}`);
      } else {
        run(stage.prep, {verbose: opts.verbose});
      }
    }

    // 2. 运行 workflow
    if (stage.workflow) {
      const landFlag = opts.land ? '--land' : '';
      const skipFlag = opts.skipIfLanded ? '--skip-if-landed' : '';
      const argsFlag = stage.args || '';
      let intakeArgsFlag = '';
      let briefFlag = '';

      // intake 需要 objective 和 sourceCommit，从 git 和已有 brief 读取
      if (stage.needsObjective) {
        const commitHash = run('git rev-parse --short HEAD', {verbose: false}).stdout.trim();
        // 尝试从已有 brief 读取 objective，否则用项目默认值
        const briefPath = path.join(REPO, 'teams/council/inputs/design_brief.intake.json');
        const m2Path = path.join(REPO, 'teams/council/inputs/design_brief.m2.json');
        let objective = 'K3/GLM-5.2/DeepSeek-V4-Pro 三模型推理芯片架构探索，目标 1000 TPS/usr 单用户 Decode，1M context';
        if (fs.existsSync(briefPath)) {
          try {
            const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
            if (brief.objective) objective = brief.objective;
          } catch (_) {}
        } else if (fs.existsSync(m2Path)) {
          try {
            const brief = JSON.parse(fs.readFileSync(m2Path, 'utf8'));
            if (brief.objective) objective = brief.objective;
          } catch (_) {}
        }
        const tmpArgs = path.join(REPO, 'scratch', `intake_args_${Date.now()}.json`);
        fs.mkdirSync(path.join(REPO, 'scratch'), {recursive: true});
        fs.writeFileSync(tmpArgs, JSON.stringify({
          objective,
          requirements: objective,
          sourceCommit: commitHash,
          mcProfile: 'MC320',
          runId: `intake-${commitHash}`,
        }));
        intakeArgsFlag = `--args ${tmpArgs}`;
      }

      // req.workload 和 req.budget 都需要 brief，但它们在预算合同生成之前跑。
      // 优先顺序: intake 落盘产物 > m2 committed brief > 无 brief（让 workflow 自行报错）
      if (stage.name === 'req.workload' || stage.name === 'req.budget') {
        const intakeBrief = path.join(REPO, 'teams/council/inputs/design_brief.intake.json');
        const m2Brief = path.join(REPO, 'teams/council/inputs/design_brief.m2.json');
        if (fs.existsSync(intakeBrief)) {
          briefFlag = `--brief teams/council/inputs/design_brief.intake.json`;
        } else if (fs.existsSync(m2Brief)) {
          briefFlag = `--brief teams/council/inputs/design_brief.m2.json`;
          console.log(`│  [NOTE] intake brief 不存在，使用 m2 committed brief 作为替代`);
        }
      }

      const cmd = `node integration/pipelines/run_workflow.js ${stage.workflow} --backend ${opts.backend} ${landFlag} ${skipFlag} ${intakeArgsFlag} ${briefFlag} ${argsFlag}`.trim().replace(/\s+/g, ' ');

      console.log(`│  [RUN]  ${cmd}`);

      const result = run(cmd, {verbose: opts.verbose, ignoreError: stage.optional || opts.backend === 'mock'});

      if (!result.ok && stage.optional) {
        console.log('└─ ⚠ 可选阶段失败，继续');
      } else {
        console.log('└─ ✓ 完成');
      }
    } else {
      console.log('└─ ✓ 完成');
    }

    console.log('');
  }

  console.log('');
  console.log('='.repeat(80));
  console.log('探索完成');
  console.log('='.repeat(80));

  // 总结产物
  console.log('\n产物清单:');
  const outputs = [
    'teams/council/inputs/design_brief.intake.json',
    'out/requirements/workload/req_workload.json',
    'out/budget/L1_budget.json',
    'out/direction/direction_selected.json',
    'out/compute/compute_winner.json',
    'out/sram/sram_winner.json',
    'out/mc/mc_winner.json',
    'out/comm/comm_winner.json',
    'out/physical/physical_winner.json',
    'out/coupling/joint_point.json',
    'out/detailed/detail_integrate.json',
    'out/detailed/converge_proposal.json',
  ];

  for (const output of outputs) {
    const fullPath = path.join(REPO, output);
    if (fs.existsSync(fullPath)) {
      const stats = fs.statSync(fullPath);
      const size = (stats.size / 1024).toFixed(1);
      console.log(`  ✓ ${output} (${size} KB)`);
    } else {
      console.log(`  ✗ ${output} (不存在)`);
    }
  }

  console.log('\n下一步:');
  console.log('  - 运行验证: node integration/pipelines/run_workflow.js design.verify --backend codex --land');
  console.log('  - 检查门控: node integration/governance/evaluate_gates.js');
  console.log('  - 查看产物: cat out/detailed/converge_proposal.json | jq');
}

main();
