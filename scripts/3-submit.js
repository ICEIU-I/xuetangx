require('./workflow-client').main('submit').catch(error => { console.error(error.message); process.exitCode = 1; });
