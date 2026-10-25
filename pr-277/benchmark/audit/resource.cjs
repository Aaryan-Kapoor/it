process.on('exit',()=>require('node:fs').writeSync(3,JSON.stringify(process.resourceUsage())));
