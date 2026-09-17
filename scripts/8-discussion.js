require('./workflow/client').main('discussion').catch(error => { console.error(error.message); process.exitCode = 1; });
