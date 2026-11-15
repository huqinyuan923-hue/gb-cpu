import type { Bus, u8, u16 } from '../contract.js';

/**
 * 可选的带时序总线协议（冻结契约之外的扩展，见 README-偏差记录.md）。
 *
 * 硬件上每一次总线访问都有精确的 T 周期位置；mem_timing 这类时序测试需要
 * TIMA 递增与指令内总线访问在 T 级交错。契约的 Bus.read/write 无时序通道，
 * 因此本核心在总线实现了 readAt/writeAt 时优先走该协议：
 *
 *   readAt(addr, tInStep)  — tInStep = 本次访问发起时，当前 step 已消耗的 T 周期数
 *                           （首访问 = 0，第二次 = 4，内部 M 周期会顺移后续访问）
 *   writeAt(addr, v, tInStep)
 *
 * 未实现该协议的总线自动回退到普通 read/write，行为完全不变。
 */
export interface BusWithTiming extends Bus {
  readAt?(addr: u16, tInStep: number): u8;
  writeAt?(addr: u16, value: u8, tInStep: number): void;
}
