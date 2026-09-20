import { randomBytes, createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Express, RequestHandler } from 'express';
import { Fault } from './policy.js';

export class Identity {
  private key: Uint8Array;
  private codes=new Map<string,{subject:string; challenge:string; redirect:string; expires:number}>();
  constructor(public issuer:string, secret?:string) {
    if(secret && secret.length<32) throw new Error('TOKEN_SECRET must have at least 32 characters.');
    this.key=secret ? new TextEncoder().encode(secret):randomBytes(32);
  }
  async issue(subject:string,audience='teamspace',scopes='read write') {
    return new SignJWT({scope:scopes}).setProtectedHeader({alg:'HS256'}).setSubject(subject).setIssuer(this.issuer).setAudience(audience).setIssuedAt().setExpirationTime('15m').sign(this.key);
  }
  async verify(token:string,audience='teamspace') {
    try { const {payload}=await jwtVerify(token,this.key,{issuer:this.issuer,audience,algorithms:['HS256']}); if(!payload.sub) throw new Error(); return payload.sub; }
    catch { throw new Fault('UNAUTHORIZED','A valid, unexpired token for this service is required.',401); }
  }
  async subject(header?:string,audience='teamspace') {
    if(!header?.startsWith('Bearer ')) throw new Fault('UNAUTHORIZED','Sign in to Teamspace.',401);
    return this.verify(header.slice(7),audience);
  }
  mount(app:Express,dev:boolean) {
    app.get('/.well-known/oauth-protected-resource',(_req,res)=>res.json({resource:`${this.issuer}/mcp`,authorization_servers:[this.issuer],scopes_supported:['read','write']}));
    app.get('/.well-known/oauth-authorization-server',(_req,res)=>res.json({issuer:this.issuer,authorization_endpoint:`${this.issuer}/authorize`,token_endpoint:`${this.issuer}/token`,response_types_supported:['code'],grant_types_supported:['authorization_code'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none']}));
    // Local teaching identity provider, never an Internet-facing login system.
    if(!dev) return;
    app.post('/dev/token',async(req,res,next)=>{try {
      if(!['alice','bob','viewer','sam','eve'].includes(req.body.subject)) throw new Fault('INVALID_USER','Choose a seeded user.');
      res.json({access_token:await this.issue(req.body.subject),token_type:'Bearer',expires_in:900});
    }catch(e){next(e);}});
    app.get('/authorize',(req,res,next)=>{try {
      const {client_id,redirect_uri,code_challenge,code_challenge_method,response_type,subject,state}=req.query;
      // Pre-registered loopback redirect; never accept an arbitrary redirect destination.
      if(client_id!=='teamspace-host' || redirect_uri!==`${this.issuer}/callback` || response_type!=='code' || code_challenge_method!=='S256' || typeof code_challenge!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(code_challenge) || !['alice','bob','viewer','sam','eve'].includes(String(subject))) throw new Fault('INVALID_AUTHORIZATION','Invalid local authorization request.');
      const code=randomBytes(24).toString('base64url');
      this.codes.set(code,{subject:String(subject),challenge:code_challenge,redirect:String(redirect_uri),expires:Date.now()+60000});
      const callback=new URL(String(redirect_uri)); callback.searchParams.set('code',code); callback.searchParams.set('iss',this.issuer); if(typeof state==='string') callback.searchParams.set('state',state);
      res.redirect(callback.toString());
    }catch(e){next(e);}});
    app.post('/token',async(req,res,next)=>{try {
      const p=req.body, c=this.codes.get(p.code); this.codes.delete(p.code);
      if(!c || c.expires<Date.now() || p.grant_type!=='authorization_code' || p.client_id!=='teamspace-host' || p.redirect_uri!==c.redirect || p.resource!==`${this.issuer}/mcp` || typeof p.code_verifier!=='string' || createHash('sha256').update(p.code_verifier).digest('base64url')!==c.challenge) throw new Fault('INVALID_GRANT','Expired code, invalid verifier, client, redirect, or resource.');
      res.json({access_token:await this.issue(c.subject),token_type:'Bearer',expires_in:900});
    }catch(e){next(e);}});
  }
}

// The edge check for /mcp. It must run BEFORE the MCP handler. A Fault thrown from inside
// createMcpHandler's factory is reported by the SDK as a 500 "Internal server error", so the
// client would never receive the 401 challenge that tells it where to sign in.
export function requireToken(identity: Identity, origin: string, audience = 'teamspace'): RequestHandler {
  return async (req, res, next) => {
    try {
      await identity.subject(req.headers.authorization, audience);
      next();
    } catch {
      res
        .status(401)
        .set('WWW-Authenticate', `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`)
        .json({ code: 'UNAUTHORIZED', message: 'Sign in to Teamspace.' });
    }
  };
}
