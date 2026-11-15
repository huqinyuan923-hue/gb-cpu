import { createSM83, type SM83Debug } from '../../src/cpu/createCPU';
import type { Bus, SM83, u8, u16 } from '../../src/contract';

/** TAC 分频周期（T 周期）：00=1024 01=16 10=64 11=256 */
const TIMA_PERIODS = [1024, 16, 64, 256] as const;

/**
 * 测试机器壳：RAM + 串口 + 计时器 + 最小 MBC1（供 blargg ROM 运行）。
 *
 * 串口协议（blargg 裁判）：ROM 把字符写 $FF01(SB)，再写 $FF02(SC)=0x81 启动发送。
 * 内部时钟每位 512T，8 位共 4096T；发送完成后清 SC bit7 并请求串口中断(bit3)。
 * 直接在总线层把发送字节拼进输出文本。
 *
 * 计时器（instr_timing 需要）：DIV 为 16 位 T 计数器（读 $FF04 取高 8 位），
 * TIMA 按 TAC 分频计数，溢出重载 TMA 并请求计时器中断(bit2)。
 *
 * 最小 MBC1（合并版 64KB ROM 用）：$0000-$3FFF 恒银行 0，$4000-$7FFF 按写
 * $2000-$3FFF 的银行号切（64KB ROM 只需银行 1）。
 */
export class TestMachine implements Bus {
  readonly cpu: SM83 & SM83Debug;
  /** 串口输出文本（裁判读这里） */
  serialOutput = '';

  private ram = new Uint8Array(0x10000);
  // 串口
  private sb = 0;
  private sc = 0;
  private serialTicksLeft = 0;
  // 计时器（T 级惰性精确模型）
  private absT = 0; // 自复位以来的总 T 周期
  private divBase = 0; // DIV 纪元：内部 16 位计数器 = absT - divBase（写 $FF04 归零）
  private tima = 0;
  private timaLastT = 0; // TIMA 已推进到的时刻
  private tma = 0;
  private tac = 0;
  // 壳级 PPU 时序（无渲染，只为 blargg ROM 的 LY 轮询 / VBlank / STAT 中断供拍）
  private dots = 0; // 帧内 dot 计数（154 × 456）
  private ly = 0;
  private lyc = 0;
  private stat = 0; // $FF41 写入的使能位（bit3-6）
  private prevMode = 0;
  private lastLy = 0;
  // OAM DMA（$FF46）：写后 160T 延迟整块拷贝（任务书允许的简化）
  private dmaSrc = 0;
  private dmaTicksLeft = 0;
  // MBC1
  private romBank = 1;
  /** 载入的 ROM（bank0 = 前 16KB，bank1 = 后 16KB） */
  private rom: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  constructor() {
    this.cpu = createSM83(this);
  }

  loadRom(bytes: Uint8Array): void {
    this.rom = bytes;
    this.ram.fill(0);
    this.serialOutput = '';
    this.sb = 0; this.sc = 0; this.serialTicksLeft = 0;
    this.absT = 0; this.divBase = 0; this.tima = 0; this.timaLastT = 0; this.tma = 0; this.tac = 0;
    this.dots = 0; this.ly = 0; this.lyc = 0; this.stat = 0; this.prevMode = 0; this.lastLy = 0;
    this.dmaSrc = 0; this.dmaTicksLeft = 0;
    this.romBank = 1;
    // 无 boot ROM 的起跑态：卡带入口 $0100、SP=$FFFE、IME 关
    this.cpu.reset();
    this.cpu.debugSet({ pc: 0x0100, sp: 0xFFFE, ime: false, halted: false });
  }

  read(addr: u16): u8 {
    return this.readAt(addr, 0);
  }

  /** 带时序总线协议：tInStep = 访问发起时本 step 已消耗的 T 数 */
  readAt(addr: u16, tInStep: number): u8 {
    const T = this.absT + tInStep;
    if (addr < 0x8000) {
      // ROM 区：bank0 / 当前 bank
      if (addr < 0x4000) return this.rom[addr] ?? 0xFF;
      const bank = this.romBank & 0x1F;
      return this.rom[bank * 0x4000 + (addr - 0x4000)] ?? 0xFF;
    }
    switch (addr) {
      case 0xFF01: return this.sb;
      case 0xFF02: return this.sc;
      case 0xFF04: {
        this.syncTimer(T);
        return ((T - this.divBase) >> 8) & 0xFF;
      }
      case 0xFF05: {
        this.syncTimer(T);
        return this.tima;
      }
      case 0xFF06: return this.tma;
      case 0xFF07: return this.tac | 0xF8;
      case 0xFF41: {
        // STAT：写入的使能位 + 实时模式位/ coincidence
        const dotInLine = this.dots % 456;
        const mode = this.ly >= 144 ? 1 : dotInLine < 80 ? 2 : dotInLine < 252 ? 3 : 0;
        return (this.stat & 0x78) | (this.ly === this.lyc ? 0x04 : 0) | mode | 0x80;
      }
      case 0xFF44: return this.ly;
      case 0xFF45: return this.lyc;
      default: return this.ram[addr] ?? 0;
    }
  }

  write(addr: u16, value: u8): void {
    this.writeAt(addr, value, 0);
  }

  writeAt(addr: u16, value: u8, tInStep: number): void {
    const T = this.absT + tInStep;
    if (addr < 0x8000) {
      // MBC1 控制写：$2000-$3FFF 选 bank（低 5 位；0 视作 1）
      if (addr >= 0x2000 && addr <= 0x3FFF) {
        const b = value & 0x1F;
        this.romBank = b === 0 ? 1 : b;
      }
      return;
    }
    switch (addr) {
      case 0xFF01: this.sb = value; break;
      case 0xFF02: {
        this.sc = value & 0xFF;
        if (this.sc & 0x80) {
          // 发送启动：锁存 SB，8 位 × 512T
          this.serialOutput += String.fromCharCode(this.sb);
          this.serialTicksLeft = 4096;
        }
        break;
      }
      case 0xFF04: {
        // 写任意值清零内部计数器：纪元重置到本次写生效时刻
        this.syncTimer(T);
        this.divBase = T;
        break;
      }
      case 0xFF05: {
        this.syncTimer(T);
        this.tima = value;
        this.timaLastT = T;
        break;
      }
      case 0xFF06: this.tma = value; break;
      case 0xFF07: {
        this.syncTimer(T);
        this.tac = value & 0x07;
        break;
      }
      case 0xFF41: this.stat = value & 0x78; break; // 使能位（bit3-6）
      case 0xFF45: this.lyc = value; break;
      case 0xFF46: { // OAM DMA：记录源页，tick 里延迟 160T 拷贝
        this.dmaSrc = (value << 8) & 0xFFFF;
        this.dmaTicksLeft = 160;
        break;
      }
      default: this.ram[addr] = value & 0xFF; break;
    }
  }

  /**
   * 把 TIMA 惰性推进到时刻 T（按 TAC 分频的精确 tick 序列；
   * tick 落在 counter ≡ 0 (mod period) 的 T 位置——与硬件下降沿一致）。
   */
  private syncTimer(T: number): void {
    if (!(this.tac & 0x04) || T <= this.timaLastT) {
      this.timaLastT = Math.max(this.timaLastT, T);
      return;
    }
    const period = TIMA_PERIODS[this.tac & 3] ?? 1024;
    let t = this.timaLastT;
    // 从 timaLastT 到 T 之间的每个 tick 时刻
    const firstK = Math.ceil((t + 1 - this.divBase) / period);
    for (let k = firstK; this.divBase + k * period <= T; k++) {
      this.tima = (this.tima + 1) & 0xFF;
      if (this.tima === 0) {
        this.tima = this.tma; // 溢出重载（4T 重载延迟窗口不建模，壳级简化）
        this.cpu.requestInterrupt(2);
      }
      t = this.divBase + k * period;
    }
    this.timaLastT = T;
  }

  /** 调试读（探针用）：经同一套 read 路由 */
  debugRead(addr: u16): u8 {
    return this.read(addr);
  }

  /** 推进 t 个 T 周期的外设节拍（CPU step 返回值直接喂进来） */
  tick(t: number): void {
    this.absT += t;
    this.syncTimer(this.absT); // TIMA 在无访问时也要推进（含溢出中断请求）
    // 串口发送完成
    if (this.serialTicksLeft > 0) {
      this.serialTicksLeft -= t;
      if (this.serialTicksLeft <= 0) {
        this.sc &= 0x7F;
        this.cpu.requestInterrupt(3);
      }
    }
    // OAM DMA：延迟 160T 后整块拷贝（壳级简化，见 README-偏差记录.md）
    if (this.dmaTicksLeft > 0) {
      this.dmaTicksLeft -= t;
      if (this.dmaTicksLeft <= 0) {
        for (let i = 0; i < 160; i++) {
          this.ram[0xFE00 + i] = this.read((this.dmaSrc + i) & 0xFFFF);
        }
      }
    }
    // 壳级 PPU 时序：dot 计数 → LY / 模式切换 / VBlank·STAT 中断沿
    this.dots = (this.dots + t) % (154 * 456);
    this.ly = Math.floor(this.dots / 456);
    const dotInLine = this.dots % 456;
    const mode = this.ly >= 144 ? 1 : dotInLine < 80 ? 2 : dotInLine < 252 ? 3 : 0;
    if (mode !== this.prevMode) {
      // 模式沿：mode 0/1/2 进入时按使能位请求 STAT 中断（IF bit1）
      if ((mode === 0 && this.stat & 0x08) || (mode === 1 && this.stat & 0x10) || (mode === 2 && this.stat & 0x20)) {
        this.cpu.requestInterrupt(1);
      }
      this.prevMode = mode;
    }
    if (this.ly === 144 && this.lastLy !== 144) {
      this.cpu.requestInterrupt(0); // VBlank 开始沿（真实 PPU 无条件请求，IE 门在 CPU 侧）
    }
    if (this.ly === this.lyc && this.stat & 0x40) {
      this.cpu.requestInterrupt(1); // LYC=LY（壳级简化：电平触发而非单沿）
    }
    this.lastLy = this.ly;
  }

  /**
   * 跑到满足条件或超时。返回累计 T 周期。
   * 长跑场景每步都过 tick()，外设与 CPU 同拍推进。
   */
  run(maxT: number, until?: () => boolean): number {
    let t = 0;
    while (t < maxT) {
      const s = this.cpu.step();
      this.tick(s);
      t += s;
      if (until && until()) break;
    }
    return t;
  }
}
