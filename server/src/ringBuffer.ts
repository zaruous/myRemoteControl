// PTY 출력 보관용 링 버퍼. seq = "세션 시작 이후 누적 문자 수(UTF-16 code unit)".
// 청크 번호가 아닌 오프셋을 쓰는 이유: 클라이언트가 "여기까지 받았다"를 정확히 표현할 수 있고
// 청크 경계와 무관하게 중간부터 이어 보낼 수 있다.
export class RingBuffer {
  private chunks: { start: number; data: string }[] = [];
  private size = 0;
  private end = 0; // 다음에 쓸 오프셋 = 지금까지 쓴 총량

  constructor(private readonly maxChars: number) {}

  get head() { return this.end; }
  get tail() { return this.chunks.length ? this.chunks[0].start : this.end; }

  push(data: string): number {
    const start = this.end;
    this.chunks.push({ start, data });
    this.end += data.length;
    this.size += data.length;
    // ponytail: Array.shift는 O(n). 청크 수가 수만 개를 넘으면 원형 배열로 교체.
    while (this.size > this.maxChars && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.data.length;
    }
    return start;
  }

  /** offset부터 끝까지. offset이 이미 밀려났거나(>end 포함) 범위 밖이면 gap=true + 남은 전체 반환 */
  readFrom(offset: number): { start: number; data: string; gap: boolean } {
    if (!Number.isInteger(offset) || offset < this.tail || offset > this.end) {
      return { start: this.tail, data: this.chunks.map(c => c.data).join(''), gap: true };
    }
    const out: string[] = [];
    for (const c of this.chunks) {
      if (c.start + c.data.length <= offset) continue;
      out.push(offset > c.start ? c.data.slice(offset - c.start) : c.data);
    }
    return { start: offset, data: out.join(''), gap: false };
  }
}
