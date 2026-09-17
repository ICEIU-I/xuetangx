require('./workflow-client').main('check').catch(error => { console.error(error.message); process.exitCode = 1; });
