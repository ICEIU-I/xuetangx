require('./workflow-client').main('complete-course').catch(error => { console.error(error.message); process.exitCode = 1; });
