import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestMachine } from '../helpers/machine';

/**
 * M4：blargg cpu_instrs（01-11，serial 抓文本断言）。
 * ROM 来源 retrio/gb-test-roms；单个子测 32KB 无 MBC，$0000 直接载入。
 * 裁判协议：ROM 把字符写 $FF01(SB)、写 $FF02(SC)=0x81 移出；
 * 测试壳在总线层拼文本，出现 "passed" / "failed N" 即停机断言。
 */

const ROM_DIR = join(process.cwd(), 'tests', 'roms');

/** 运行单个 ROM 到 serial 出现结果或超时，返回 serial 文本 */
function runRom(name: string, maxT = 400_000_000): { text: string; cycles: number; done: boolean } {
  const m = new TestMachine();
  m.loadRom(new Uint8Array(readFileSync(join(ROM_DIR, name))));
  let seen = 0;
  let done = false;
  const cycles = m.run(maxT, () => {
    if (m.serialOutput.length !== seen) {
      seen = m.serialOutput.length;
      if (/passed|failed \d/i.test(m.serialOutput)) {
        done = true;
        return true;
      }
    }
    return false;
  });
  return { text: m.serialOutput.trim(), cycles, done };
}

const SUBTESTS = [
  '01-special.gb',
  '02-interrupts.gb',
  '03-op sp,hl.gb',
  '04-op r,imm.gb',
  '05-op rp.gb',
  '06-ld r,r.gb',
  '07-jr,jp,call,ret,rst.gb',
  '08-misc instrs.gb',
  '09-op r,r.gb',
  '10-bit ops.gb',
  '11-op a,(hl).gb',
];

describe('M4 blargg cpu_instrs（serial 裁判）', () => {
  for (const rom of SUBTESTS) {
    it(
      `${rom} → passed`,
      () => {
        const { text, cycles, done } = runRom(rom);
        expect(text, `serial 输出：${text}`).toMatch(/passed/i);
        expect(done, '应在结果出现后正常停机').toBe(true);
        expect(cycles).toBeLessThan(400_000_000);
      },
      600_000,
    );
  }

  it(
    'halt_bug ROM → 内存协议 $A000=1（签名 DE B0 61 + 结果码；该 ROM 不走串口）',
    () => {
      const m = new TestMachine();
      m.loadRom(new Uint8Array(readFileSync(join(ROM_DIR, 'halt_bug.gb'))));
      let done = false;
      const cycles = m.run(120_000_000, () => {
        // blargg 内存协议：$A001-$A003 = 签名 DE B0 61；$A000：1=passed，2+ =错误码，0x80=进行中
        const r = m.debugRead(0xA000);
        if (r === 1 || (r >= 2 && r < 0x80)) {
          done = true;
          return true;
        }
        return false;
      });
      expect(done, '应在超时前写出结果码').toBe(true);
      expect(m.debugRead(0xA001)).toBe(0xDE); // 签名
      expect(m.debugRead(0xA002)).toBe(0xB0);
      expect(m.debugRead(0xA003)).toBe(0x61);
      expect(m.debugRead(0xA000), 'blargg 结果码（1=passed）').toBe(1);
      expect(cycles).toBeLessThan(120_000_000);
    },
    600_000,
  );
});
