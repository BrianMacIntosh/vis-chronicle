
const path = require('path')
const fs = require('fs');

module.exports = {
	
	ensureDirectoryForFile: async function(filePath)
	{
		const directoryName = path.dirname(filePath);
		await fs.mkdir(directoryName, { recursive: true }, (err) => {
			if (err)
			{
				console.error(`Error creating output directory: ${err}`);
				throw err;
			}
		});
	}
	
}
