require('./workflow-client').main('collect-answers').catch(error => { console.error(error.message); process.exitCode = 1; });
