import { Fault } from './policy.js';
export async function retry<T>(work:(signal:AbortSignal)=>Promise<T>,options:{deadline:number;attempts?:number;safe:boolean;random?:()=>number}) {
  const attempts=options.safe ? options.attempts??3 : 1;
  for(let n=0;n<attempts;n++) {
    const remaining=options.deadline-Date.now();
    if(remaining<=0) throw new Fault('DEADLINE','The operation deadline expired.',504);
    try { return await work(AbortSignal.timeout(remaining)); }
    catch(e) {
      if(!(e instanceof Fault && e.retryable) || n===attempts-1) throw e;
      const delay=Math.floor((options.random??Math.random)()*Math.min(100*2**n,1000));
      if(Date.now()+delay>=options.deadline) throw new Fault('DEADLINE','Retry would exceed the deadline.',504);
      await new Promise(r=>setTimeout(r,delay));
    }
  }
  throw new Fault('DEADLINE','No attempts remain.',504);
}
export class CircuitBreaker {
  failures=0; openedAt=0;
  constructor(public threshold=3,public recoveryMs=1000){}
  async run<T>(work:()=>Promise<T>) {
    if(this.failures>=this.threshold && Date.now()-this.openedAt<this.recoveryMs) throw new Fault('CIRCUIT_OPEN','Dependency is recovering. Try again later.',503,true);
    try {const r=await work();this.failures=0;return r;} catch(e){this.failures++;this.openedAt=Date.now();throw e;}
  }
}
