require('./workflow-client').main('article').catch(error => { console.error(error.message); process.exitCode = 1; });
