export type ExecutionMode='realtime'|'task';
export type Operation={capability:string;semantics:string;write:boolean;freshness:'live'|'stale-ok';residency:'us'|'eu'|'any';maxLatencyMs:number;maxCostMicros:number;mode?:ExecutionMode};
export type Provider={id:string;vendor:string;capabilities:string[];semantics:string;writes:boolean;freshness:'live'|'cached';residency:'us'|'eu';mode:ExecutionMode;p95Ms:number;costMicros:number;available:boolean;trust:'verified'|'unverified'};
export type Decision={selected?:Provider;rejected:{id:string;reason:string}[];reason:string};

export function route(operation:Operation,providers:Provider[]):Decision{
  const rejected:{id:string;reason:string}[]=[],eligible:Provider[]=[];
  for(const p of providers){
    const reason=!p.available?'unavailable':p.trust!=='verified'?'unverified provider':!p.capabilities.includes(operation.capability)?'capability mismatch':p.semantics!==operation.semantics?'semantic contract mismatch':operation.write&&!p.writes?'write unsupported':operation.freshness==='live'&&p.freshness!=='live'?'freshness mismatch':operation.residency!=='any'&&p.residency!==operation.residency?'residency mismatch':operation.mode&&p.mode!==operation.mode?'execution-mode mismatch':p.p95Ms>operation.maxLatencyMs?'latency SLO exceeded':p.costMicros>operation.maxCostMicros?'cost ceiling exceeded':'';
    if(reason)rejected.push({id:p.id,reason});else eligible.push(p);
  }
  eligible.sort((a,b)=>a.costMicros-b.costMicros||a.p95Ms-b.p95Ms||a.id.localeCompare(b.id));
  return eligible.length?{selected:eligible[0],rejected,reason:'Cheapest provider satisfying the explicit semantic, policy, freshness, residency, latency and trust contract.'}:{rejected,reason:'No provider satisfies every hard constraint; the router refuses a silent downgrade.'};
}

export type CostInput={calls:number;wrapperMicros:number;backendMicros:number;vendorModelMicros:number;clientInputTokens:number;clientOutputTokens:number;clientMicrosPerMillionInput:number;clientMicrosPerMillionOutput:number};
export function estimateCost(x:CostInput){const vendorPerCall=x.wrapperMicros+x.backendMicros+x.vendorModelMicros;const vendorTotal=x.calls*vendorPerCall;const clientModel=Math.round(x.clientInputTokens*x.clientMicrosPerMillionInput/1_000_000+x.clientOutputTokens*x.clientMicrosPerMillionOutput/1_000_000);return{vendorPerCall,vendorTotal,clientModel,total:vendorTotal+clientModel,shares:{vendor:Number((vendorTotal/(vendorTotal+clientModel||1)).toFixed(3)),client:Number((clientModel/(vendorTotal+clientModel||1)).toFixed(3))}};}

export const providers:Provider[]=[
 {id:'teamspace-standard-us',vendor:'teamspace',capabilities:['task.search','page.search'],semantics:'teamspace-v1',writes:false,freshness:'live',residency:'us',mode:'realtime',p95Ms:450,costMicros:20,available:true,trust:'verified'},
 {id:'teamspace-priority-us',vendor:'teamspace',capabilities:['task.search','page.search','task.write'],semantics:'teamspace-v1',writes:true,freshness:'live',residency:'us',mode:'realtime',p95Ms:120,costMicros:90,available:true,trust:'verified'},
 {id:'teamspace-batch-eu',vendor:'teamspace',capabilities:['page.search'],semantics:'teamspace-v1',writes:false,freshness:'cached',residency:'eu',mode:'task',p95Ms:8000,costMicros:4,available:true,trust:'verified'},
 {id:'lookalike-fast',vendor:'other',capabilities:['task.search'],semantics:'other-v2',writes:false,freshness:'live',residency:'us',mode:'realtime',p95Ms:60,costMicros:2,available:true,trust:'verified'}
];
export function defaultExperiment(){const operation:Operation={capability:'task.search',semantics:'teamspace-v1',write:false,freshness:'live',residency:'us',maxLatencyMs:500,maxCostMicros:100,mode:'realtime'};return{operation,decision:route(operation,providers),cost:estimateCost({calls:10000,wrapperMicros:2,backendMicros:18,vendorModelMicros:0,clientInputTokens:12000000,clientOutputTokens:2000000,clientMicrosPerMillionInput:500000,clientMicrosPerMillionOutput:1500000})};}
