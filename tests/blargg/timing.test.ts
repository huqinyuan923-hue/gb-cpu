import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestMachine } from '../helpers/machine';

/**
 * M5：instr_timing / mem_timing 对拍。
 * - instr_timing：32KB 无 MBC，靠计时器测量每条指令周期，serial 报结果；
 * - mem_timing：64KB MBC1（测试壳内置最小 MBC1），测总线读写时序。
 */

const ROM_DIR = join(process.cwd(), 'tests', 'roms');

function runRom(name: string, maxT = 200_000_000): { text: string; done: boolean; cycles: number } {
  const m = new TestMachine();
  m.loadRom(new Uint8Array(readFileSync(join(ROM_DIR, name))));
  let seen = 0;
  let done = false;
  const cycles = m.run(maxT, () => {
    if (m.serialOutput.length !== seen) {
      seen = m.serialOutput.length;
      if (/passed|failed/i.test(m.serialOutput)) {
        done = true;
        return true;
      }
    }
    return false;
  });
  return { text: m.serialOutput.trim(), done, cycles };
}

describe('M5 blargg 时序对拍', () => {
  it(
    'instr_timing → passed（周期账本逐条指令对拍）',
    () => {
      const { text, done, cycles } = runRom('instr_timing.gb');
      expect(text, `serial 输出：${text}`).toMatch(/passed/i);
      expect(done).toBe(true);
      expect(cycles).toBeLessThan(200_000_000);
    },
    600_000,
  );

  it(
    'mem_timing → passed（总线读写 M 周期边界）',
    () => {
      const { text, done, cycles } = runRom('mem_timing.gb');
      expect(text, `serial 输出：${text}`).toMatch(/passed/i);
      expect(done).toBe(true);
      expect(cycles).toBeLessThan(200_000_000);
    },
    600_000,
  );
});
