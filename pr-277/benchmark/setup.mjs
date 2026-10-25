import {existsSync} from 'node:fs';
import {cli,base,save,serviceHome} from './common.mjs';
if(existsSync(serviceHome))throw new Error('Initial setup requires a new service folder.');
const r=await cli(base,['setup','--none','--no-service','--name','Performance benchmark']); save('initial-setup',{ms:r.ms});console.log(JSON.stringify({setupMs:r.ms}));
