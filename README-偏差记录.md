# README-偏差记录.md · gb-cpu

> 契约（`src/contract.ts`）与任务书零改动。以下是与任务书/契约的字面差异、
> 语义取舍与工程附加项，全部在 REPORT.md 有对应论证。

## 1. TimedBus 可选时序协议（契约外扩展）

- **现象**：`mem_timing` 需要 TIMA 递增与指令内总线访问在 **T 级交错**；契约的
  `Bus.read(addr)/write(addr,v)` 没有时序通道，`step()` 只在指令边界返回总账。
- **处理**：新增 `src/cpu/timedBus.ts` 定义可选协议 `readAt(addr, tInStep)` /
  `writeAt(addr, v, tInStep)`（`tInStep` = 本次访问发起时当前 step 已消耗的 T 数）。
  核心在每次总线访问时探测总线是否实现该协议：实现则走 `readAt/writeAt`，
  否则回退普通 `read/write`，行为完全不变。
- **影响面**：additive 扩展；契约接口原样满足；主板会话可自愿采用以获得
  T 级外设对齐能力（其计时器/串口挂 T 节拍时直接受益）。

## 2. 中断服务 20T 的重叠取指模型

- 硬件中断序列 = 2 内部 M 周期 + PC 高/低字节入栈 + 向量取指 = 20T，其中
  **向量取指读到的就是处理程序第一条指令的 opcode**。
- 本实现的 `step()` 把这 4T 取指记入中断服务（合计 20T），并把取到的 opcode
  锁存（`latchedOp`），处理程序首条指令执行时不再重复取指——其周期比表值少 4T。
- 这是逐 T 等价的实现方式：从挂起到处理程序首条指令完成的墙钟时间与硬件一致。
  `instr_timing` 通过佐证了周期账本的整体正确性。

## 3. IE/IF 归属与中断应答

- 按第三部任务书（"总线：内存映射全集、IE/IF"）：**IE（$FFFF）/IF（$FF0F）
  是总线侧寄存器**。CPU 在指令边界经总线轮询二者（硬件上为片内信号，不计周期）；
  `requestInterrupt(bit)` 经总线读改写置 IF 位；应答（清服务位）同样经总线写回。
- 后果：主板侧 `$FF0F/$FFFF` 无需任何特殊路由；调试面板可直接读总线 IF/IE。

## 4. STOP 语义

- 实现为：取指 4T + 填充字节取指 4T = **8T**，PC 前进 2（CGB 硬件 STOP 本就
  读取速度切换字节；DMG 无专门测试 ROM 判此差异）。
- pandocs 指令表的"STOP = 4T"与"PC 前进 2"无法在纯取指模型下同时成立，
  取账本一致性优先。
- DMG 的整机停机语义（LCD 停、按键唤醒）归主板；CPU 侧 STOP 后照常执行。

## 5. 非法 opcode 计数与 trap 呈现

- 实测矩阵：**245 条可执行 base opcode + 256 条 CB = 501 条**，非法码 11 个
  （$D3 $DB $DD $E3 $E4 $EB $EC $ED $F4 $FC $FD）。任务书"244 个官方 opcode"
  为常见引用口径误差（256 − 11 非法 = 245）。
- trap 行为：置内部 `locked`，此后每次 `step()` 空转 4T、寄存器冻结——对应
  DMG"执行即挂起"。契约的 `CpuState` 无 locked 字段，为此在实现对象上附加
  **只读调试方法 `isLocked()`**（见第 6 条）。

## 6. 调试面（契约外附加方法）

- `isLocked(): boolean` — 非法 opcode trap 状态的唯一可观测面。
- `debugSet(patch: Partial<CpuState>)` — 寄存器注入通道：主板无 boot ROM 时
  需要把 PC 指到 $0100 起跑；测试壳的 ROM 载入也依赖它。
- 二者均为附加成员，`createSM83` 返回值仍满足冻结的 `SM83` 接口。

## 7. devDependency 追加 @types/node

- 附录 A 的 devDependencies 之外追加了 `@types/node`：blargg 测试需
  `node:fs`/`node:path`/`node:perf_hooks` 读 ROM 与计时。**npm 运行时依赖
  仍然为零**（仅类型声明，非运行代码）。

## 8. OAM DMA 一期简化

- 按任务书"写后 +160T 延迟拷贝"简化，且实现放在**测试壳**中（总线在 $FF46
  写入时记录源页，160T 后整块拷贝）。CPU 核心自身无 DMA 逻辑——DMA 期间
  CPU 总线可见性受限属主板集成课题。

## 9. 测试壳的壳级外设（非交付物）

- blargg ROM 需要最小外设供拍：壳级 PPU 时序（LY/模式位/STAT·VBlank 中断沿，
  无渲染）、串口（SB/SC + 4096T 发送完成 + 串口中断）、T 级精确计时器
  （惰性推进到任意 T 时刻，DIV 纪元重置建模）、最小 MBC1（mem_timing 64KB）。
  均在 `tests/helpers/machine.ts`，不进入 `src/` 交付面。

## 10. cpu_instrs 采用 11 个 individual ROM

- 合并版 `cpu_instrs.gb` 为 64KB（MBC1）；individual 子测为 32KB 无 MBC，
  与任务书"cpu_instrs 为 32KB 无 MBC"的描述一致。11 个子测逐一跑通。

## 11. HALT bug 的 EI 交互判定

- `EI` 之后立即 `HALT` 且有挂起中断：判定为**正常停机**（EI 悬置期视为
  "IME 即将开启"），停机结束时 IME 生效、下一步直接服务——不触发 HALT bug。
  依据：blargg `halt_bug` ROM 的通过行为。
