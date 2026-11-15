# REPORT.md · gb-cpu · SM83 CPU 部

> Game Boy（DMG）模拟器三部曲 · 第一部交付报告。
> 任务书：`C:\works\零维护项目群\第一部-SM83任务书.md`。规格 1989 年冻结，完工即封存，零维护。

## 最终状态

| 验收项 | 状态 | 证据 |
|---|---|---|
| `npm test && npm run typecheck` 全绿 | ✅ | **952 用例 / 0 失败**，tsc strict 零告警，全套 7s |
| 500 opcode 单元测试全覆盖（≥500 用例） | ✅ | 全 opcode 枚举对拍 530 条 + 语义/边界专项 393 条 |
| blargg cpu_instrs 01-11 全部 passed | ✅ | serial 抓文本断言，11/11 |
| instr_timing 与 mem_timing 通过 | ✅ | **双通过**（见"TimedBus"一节，未走"失败留档"豁免通道） |
| HALT bug / EI 延迟 / DAA 四象限专项测试 | ✅ | interrupts.test.ts 31 条 + daa.test.ts 15 条（含 400 组十进制真值对拍） |
| 性能基准留档 | ✅ | 混合负载 1 帧 70224T ≈ **0.21ms**（目标 <1ms）；吞吐 333M T/s ≈ **79× 实机** |
| 加赠：blargg halt_bug ROM | ✅ | 内存协议 $A000=1（该 ROM 不走串口） |
| 无 probe 残留 / 契约零改动 | ✅ | `src/contract.ts` 与附录 B 逐字节一致；取舍记录于 README-偏差记录.md |

测试分布：全 opcode 枚举 530 · ALU 矩阵 178 · CB 页 94 · 中断系统 31 · 核心/栈/标志 29 · 控制流 23 · LD 寻址 22 · DAA 15 · 差分对拍 10 · blargg ROM 14 · 模糊 2 · 性能 3 · 骨架 1。

## 一、架构：一部按总线活动记账的 CPU

### 1.1 周期账本（本实现的核心主张）

指令周期数**不查表**。全 CPU 只有三个记账点：

```ts
read8()  → stepCycles += 4   // 一次总线读 = 一个 M 周期
write8() → stepCycles += 4   // 一次总线写
idle()   → stepCycles += 4   // 内部 M 周期
```

`LD A,(nn)` 是 16T，因为它的总线活动恰好是：取指(4) + 读地址低(4) + 读地址高(4) + 读数据(4)。
`RET cc` 不成立 8T、成立 20T，因为不成立时只有取指 + 一个内部周期。周期表是账本的**输出**而非输入——
这套账本随后被 `instr_timing`（对拍全部 500 条指令的实测周期）逐条验证。

### 1.2 派发结构

`run(op)` 一个 switch：显式 case 覆盖全部"独苗"指令，四个规则区间
（`LD r,r'` 0x40-0x7F / `ALU A,r` 0x80-0xBF / 0x04-0x3E 组 / 16 位组）落到 default 用位运算收编。
CB 页按 `x/y/z` 三段解码，4 条路径覆盖 256 条。派发穷尽性由 `unreachable()` 守护——
漏一个 opcode 会在"合法 opcode 数量 = 245"这条测试上当场爆掉。

### 1.3 中断流水线

- IE/IF 是总线侧寄存器（第三部主板管内存映射）：CPU 在指令边界经总线轮询，
  `requestInterrupt(bit)` 经总线置 IF 位，应答经总线清位。轮询与应答是片内信号，不计周期。
- 服务序列 20T：2 内部 + 入栈×2 + **向量取指**。向量取指读到的就是处理程序第一条指令的
  opcode——硬件在此处取指与服务重叠，本实现把 opcode 锁存（`latchedOp`），
  处理程序首条指令不再重复取指。逐 T 等价（详见偏差记录 §2）。
- EI 延迟用计数器建模：EI 置 2，每条指令边界递减，减到 0 时 IME=1。
  `EI;DI` → DI 取消悬置（DI 清计数器）；`EI;EI` → 第二条 EI 结束即生效；`EI;HALT` → 停机结束时生效。
- HALT bug：`IME=0 && EI 未悬置 && IE&IF≠0` 时执行 HALT → 不真停机，锁存 bug 状态，
  下一条取指 PC 不递增（该字节被读两次，引发经典的"错位执行"连锁）。

### 1.4 TimedBus：冻结契约与 T 级对齐的矛盾及其解法

`mem_timing` 的检测原理：用 64 M 周期周期的 TIMA 作时序基准，把被测指令的 (HL) 读取
落在哪个 T 周期上对出来。这要求 **TIMA 递增与总线访问在 T 级交错**——而契约的
`Bus.read(addr)` 没有时序通道，`step()` 只在指令边界交账。

解法是给核心加一个**可选协议**：总线若实现 `readAt(addr, tInStep)` / `writeAt(addr, v, tInStep)`
（`tInStep` = 本次访问发起时本 step 已消耗的 T 数），核心就走它；否则回退普通读写，行为不变。
测试壳的计时器于是可以惰性推进到任意 T 时刻（tick 落在与硬件下降沿一致的
`counter ≡ 0 (mod period)` 位置，DIV 写重置纪元），mem_timing 与 instr_timing 双双通过。

这条扩展写进了偏差记录（§1），主板会话可自愿采用——它的计时器/串口挂 T 节拍时直接受益。

### 1.5 非法 opcode trap

11 个未分配码（$D3 $DB $DD $E3 $E4 $EB $EC $ED $F4 $FC $FD）执行即置 `locked`：
此后每次 `step()` 空转 4T、寄存器冻结——对应 DMG"执行即挂起"，主板主循环无需任何特殊处理。
锁死状态通过附加的 `isLocked()` 调试方法暴露（契约的 CpuState 无处安放它）。

## 二、验证体系（五层）

1. **全 opcode 枚举对拍（530 条）**：每条 base opcode（条件类 taken/not-taken 各一遍）+ 256 条 CB，
   与独立书写的周期预言机表逐条对拍周期数与 PC 推进。开工第一天就抓出 4 个真缺陷：
   漏实现 RLCA/RRCA/RLA/RRA、INC/DEC rr 少记内部周期、INC/DEC (HL) 多记内部周期、RST 目标计算错。
2. **语义/边界专项（393 条）**：ALU 边界矩阵（00/0F/80/FF 四象限 × 8 运算 × 进位输入 × 三种寻址）、
   DAA 四象限金向量 + 400 组"十进制算术真值为裁判"的 BCD 性质对拍、(HL±) 步进与 $FFFF 回绕、
   栈序与 SP 回绕、控制流跨页/嵌套、条件码全矩阵。
3. **中断系统专项（31 条）**：20T 服务现场、向量重叠取指、五源优先级、EI/DI/RETI 全交互、
   HALT 进入/维持/唤醒/bug、EI+HALT 不触发 bug、应答清位。
4. **blargg 官方裁判（14 条）**：cpu_instrs 01-11（serial 协议）+ halt_bug（内存协议 $A000=1）+
   instr_timing + mem_timing。全部 **passed**。
5. **差分对拍 + 模糊（12 条）**：独立书写的暴力版参考模型（静态周期表 + 平铺 switch）与主实现
   共享内存镜像，随机指令流上逐 step 对拍寄存器/SP/PC/IME/HALT/累计周期——
   8 个种子 × 2000 步 + 20000 步长流 + 全 64KB 随机流（含 HALT bug 打桩路径）。
   模糊测试做不变量扫描（周期 ≡ 0 mod 4、F 低 4 位恒 0、totalCycles 单调、永不抛异常）
   并随机注入 requestInterrupt / IF / IE / 内存改写。

**差分对拍的真实收获**：它抓住的是参考模型自己的两个转录 bug（寄存器形式 ALU 的 opcode 码点
映射错位、立即数 ALU 的运算索引取位错）。在 blargg 已给主实现背书的前提下，两个独立实现
互为对方的测试——这正是"自己出题自己批"的反毒疫苗。

## 三、性能

| 指标 | 数值 | 目标 |
|---|---|---|
| 混合负载 1 帧（70224T） | ≈ 0.21ms | < 1ms ✅ |
| 紧循环 worst-case 1 帧 | ≈ 0.2ms | < 1ms ✅ |
| 吞吐（混合负载，Node 24 / Win11） | **333M T/s ≈ 79× 实机** | — |

基准随测试入库（`tests/perf.test.ts`），断言护栏：每帧 < 1ms、吞吐 ≥ 1× 实机。

## 四、已知限制（全部记录在 README-偏差记录.md）

- STOP：8T + PC+2，不做整机停机（DMG 整机语义归主板）。
- OAM DMA 简化为壳级"写后 160T 延迟整块拷贝"；DMA 期间 CPU 总线可见性受限属主板课题。
- 壳级外设（LY/STAT/串口/计时器/MBC1）是测试环境，不在 `src/` 交付面。
- TIMA 溢出的 4T 重载延迟窗口、STAT 中断的电平/单沿细节未做（壳级简化，非 CPU 语义）。
- `EI` 后立即 `HALT` 且有挂起中断：判定为正常停机（blargg halt_bug 通过佐证）。

## 五、博客素材要点

1. **"周期不查表，查的是账本"**——三个记账点推出整张周期表，再用 blargg 的 instr_timing 反向验证
   500 条指令的账目，是全文最干净的一条主线。
2. **中断服务 20T 里藏着一条指令的取指**——向量取指与中断序列重叠，锁存 opcode 的实现让
   "step() 返回 20T"与"下一条指令便宜 4T"同时成立，墙钟与硬件逐 T 对齐。
3. **冻结契约与 T 级现实的碰撞**——mem_timing 逼出了"总线访问携带 T 位置"的可选协议；
   接口冻结不等于信息冻结，additive 扩展是唯一正道。
4. **差分对拍抓住的是"裁判"自己的 bug**——两个独立实现互测，比任何单一实现的自测都凶。
5. **HALT bug 的完整因果链**——IME=0 + 挂起中断 + HALT → PC 少走一字节 → opcode 被当操作数
   再读一遍 → 整个指令流错位，blargg 用内存协议判它 pass。

## 六、工程痕迹

- 工程：`C:\works\gb-cpu`，TypeScript strict + `noUncheckedIndexedAccess`，零 npm 运行时依赖。
- 交付面：`src/cpu/createCPU.ts`（入口）、`src/cpu/sm83.ts`（核心）、`src/cpu/alu.ts`（纯函数 ALU）、
  `src/cpu/timedBus.ts`（可选协议）、`src/index.ts`（导出）、`src/contract.ts`（冻结，逐字节照抄附录 B）。
- 测试：`tests/unit`（语义）、`tests/blargg`（官方裁判）、`tests/diff`（差分）、`tests/fuzz.test.ts`、
  `tests/perf.test.ts`、`tests/helpers`（假总线 / 测试机器壳 / 参考模型 / 单步工具）。
- ROM 不入库（`tests/roms/` gitignore），来源 retrio/gb-test-roms。
