require('./workflow-client').main('video').catch(error => { console.error(error.message); process.exitCode = 1; });
