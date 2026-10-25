import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const dir='/tmp/it-perf/cli-audit';
mkdirSync(dir,{recursive:true});
const base=readFileSync('/tmp/it-perf/baseline/it.mjs','utf8');
const match=/^var FUNCTIONS = (.*);$/m.exec(base);
if(!match)throw Error('missing functions');
const original=new Function('return '+match[1])();
const packed=gzipSync(original,{level:9}).toString('base64');
if(gunzipSync(Buffer.from(packed,'base64')).toString('utf8')!==original)throw Error('roundtrip');
const hash=createHash('sha256').update(original).digest('hex');
const eager='var FUNCTIONS = __auditGunzip(Buffer.from('+JSON.stringify(packed)+',"base64")).toString("utf8");';
const lazy='var PACKED_FUNCTIONS = '+JSON.stringify(packed)+';\nfunction auditFunctions(){return __auditGunzip(Buffer.from(PACKED_FUNCTIONS,"base64")).toString("utf8");}';
for(const [name,code] of Object.entries({'functions-eager':base.replace(match[0],eager),'functions-lazy':base.replace(match[0],lazy).replace('JSON.parse(FUNCTIONS)','JSON.parse(auditFunctions())')})){
 const withImport=code.replace('#!/usr/bin/env node\n',"#!/usr/bin/env node\nimport {gunzipSync as __auditGunzip} from 'node:zlib';\n");
 writeFileSync(dir+'/'+name+'.mjs',withImport);
 console.log(JSON.stringify({name,bytes:Buffer.byteLength(withImport),functionsLiteralBytes:Buffer.byteLength(match[0]),rawBytes:Buffer.byteLength(original),gzipBytes:Buffer.from(packed,'base64').length,base64Bytes:packed.length,hash}));
}
