import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
export async function connect(url:string,token:string) {
  const client=new Client({name:'teamspace-reference-host',version:'1.0.0'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});
  await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
  return client;
}
export type Trace={layer:'host'|'model'|'mcp';event:string;data:unknown};
export async function prepareRelease(url:string,token:string) {
  const trace:Trace[]=[], client=await connect(url,token);
  try {
    const tools=await client.listTools();trace.push({layer:'mcp',event:'tools/list',data:tools.tools.map(t=>t.name)});
    // Deterministic model substitute: no network to an LLM, no claim of reasoning.
    trace.push({layer:'model',event:'fixture tool selection',data:{name:'search_tasks',arguments:{status:'done'}}});
    const tasks:any=await client.callTool({name:'search_tasks',arguments:{status:'done'}});
    if(tasks.isError) throw new Error(tasks.content[0]?.text??'Task search failed.');
    trace.push({layer:'mcp',event:'tools/call',data:tasks});
    const page=await client.readResource({uri:'teamspace://pages/page-1'});trace.push({layer:'mcp',event:'resources/read',data:page});
    const data=tasks.structuredContent??JSON.parse(tasks.content[0].text);
    const draft={title:'Team release notes',body:`# Completed work\n\n${data.items.map((t:any)=>`- ${t.title} (${t.id})`).join('\n')}\n\nSource: Release checklist.`,taskIds:data.items.map((t:any)=>t.id),operationKey:crypto.randomUUID()};
    trace.push({layer:'host',event:'approval required',data:draft});return {draft,trace};
  }finally{await client.close();}
}
