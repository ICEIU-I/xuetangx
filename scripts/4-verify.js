require('./workflow/client').main('verify').catch(error => { console.error(error.message); process.exitCode = 1; });
