import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { createSM83 } from '../src/cpu/createCPU';
import { FakeBus } from './helpers/fakeBus';

/**
 * M6 性能基准：1 帧 = 70224 T 周期，目标 < 1ms。
 * 两组负载：紧循环（worst-case 纯取指跳转）与混合指令循环（贴近真实程序）。
 */

const FRAME_T = 70224;

/** 混合负载：一段典型程序循环（算术 + 访存 + 跳转 + 栈操作） */
function buildMixedProgram(bus: FakeBus): void {
  // $0100: 主循环体（约 60T/圈，末尾 JR 回跳）
  const code = [
    0x21, 0x00, 0xC0, // LD HL,$C000          12
    0x3E, 0x00,       // LD A,0               8
    0x06, 0x10,       // LD B,16              8
    // 循环体 @ $0107:
    0x86,             // ADD A,(HL)           8
    0x2C,             // INC L                4
    0x05,             // DEC B                4
    0x20, 0xFB,       // JR NZ,-5             12/8
    0xC5,             // PUSH BC              16
    0xC1,             // POP BC               12
    0x3C,             // INC A                4
    0x18, 0xE9,       // JR -23 → $0100       12
  ];
  bus.setBytes(0x0100, code);
  bus.setBytes(0xC000, [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10]);
}

function measure(bus: FakeBus, cpu: ReturnType<typeof createSM83>, frames: number): number {
  const target = FRAME_T * frames;
  let total = 0;
  // 预热（JIT）
  while (total < FRAME_T) total += cpu.step();
  total = 0;
  cpu.debugSet({ pc: 0x0100, totalCycles: 0 });
  const start = performance.now();
  while (total < target) total += cpu.step();
  const elapsed = performance.now() - start;
  return elapsed / frames;
}

describe('M6 性能基准', () => {
  it('混合负载：1 帧（70224T）< 1ms（100 帧均值）', () => {
    const bus = new FakeBus();
    const cpu = createSM83(bus);
    cpu.reset();
    buildMixedProgram(bus);
    const perFrame = measure(bus, cpu, 100);
    expect(perFrame, `混合负载每帧 ${perFrame.toFixed(3)}ms`).toBeLessThan(1.0);
  }, 60_000);

  it('紧循环负载（JR 自跳 worst-case 取指流）：1 帧 < 1ms', () => {
    const bus = new FakeBus();
    const cpu = createSM83(bus);
    cpu.reset();
    bus.setBytes(0x0100, [0x18, 0xFE]); // JR -2：12T/圈 自跳
    cpu.debugSet({ pc: 0x0100 });
    const perFrame = measure(bus, cpu, 100);
    expect(perFrame, `紧循环每帧 ${perFrame.toFixed(3)}ms`).toBeLessThan(1.0);
  }, 60_000);

  it('吞吐率留档：每秒可模拟的 T 周期数（混合负载）', () => {
    const bus = new FakeBus();
    const cpu = createSM83(bus);
    cpu.reset();
    buildMixedProgram(bus);
    cpu.debugSet({ pc: 0x0100 });
    const target = 20_000_000; // 约 285 帧
    let total = 0;
    const start = performance.now();
    while (total < target) total += cpu.step();
    const secs = (performance.now() - start) / 1000;
    const tPerSec = target / secs;
    console.log(`吞吐：${(tPerSec / 1e6).toFixed(1)}M T/s（= ${(tPerSec / 4194304).toFixed(0)}× 实机速率）`);
    expect(tPerSec).toBeGreaterThan(4_194_304); // 至少 1× 实机速率
  }, 120_000);
});
