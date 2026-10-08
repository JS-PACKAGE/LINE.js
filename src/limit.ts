/** At most `max` events in any trailing `windowMs`. */
export class SlidingWindowLimiter {
  private events: number[] = [];

  constructor(private readonly max: number, private readonly windowMs: number) {}

  /** Records the event and returns true when it is within budget; refused events are not recorded. */
  allow(now = Date.now()): boolean {
    while (this.events.length > 0 && now - this.events[0]! >= this.windowMs) this.events.shift();
    if (this.events.length >= this.max) return false;
    this.events.push(now);
    return true;
  }
}
