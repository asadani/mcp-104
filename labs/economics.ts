import{defaultExperiment,providers,route}from'../src/economics.js';
const baseline=defaultExperiment();
const slow=route({...baseline.operation,capability:'page.search',freshness:'stale-ok',residency:'eu',mode:'task',maxLatencyMs:10000,maxCostMicros:10},providers);
const unsafeSwap=route({...baseline.operation,semantics:'unknown-product'},providers);
console.log(JSON.stringify({baseline,slowLane:slow,unsafeSwap},null,2));
