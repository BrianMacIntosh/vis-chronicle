#!/usr/bin/env node

// Uses an input specification file to produce an output file for vis.js Timeline.

const path = require('path')
const nodeutil = require('node:util')

// parse args
const { values, positionals } = nodeutil.parseArgs({
	allowPositionals: true,
	options: {
		"verbose": { type: 'boolean', short: 'v', default: false },
		"skip-wd-cache": { type: 'boolean', default: false },
		"query-url": { type: 'string', short: 'q', default: "https://query.wikidata.org/sparql" }
	}})
	
var specFile = positionals[0]
if (!specFile)
{
	console.error(`No specification file provided.`)
	console.log(`Usage: vis-chronicle INFILE [OUTFILE]`)
}
else
{
	console.log(`Fetching using spec '${specFile}'.`)
}

var outputFile = positionals[1]
if (!outputFile)
{
	outputFile = "intermediate/timeline.json"
}

const moment = require('moment')
const fs = require('fs');
const wikidata = require('./wikidata.js')
const mypath = require("./mypath.js")

const inputSpec = require(path.join(process.cwd(), specFile))
wikidata.setInputSpec(inputSpec)
wikidata.skipCache = values["skip-wd-cache"]
wikidata.sparqlUrl = values["query-url"]
wikidata.verboseLogging = values["verbose"]
wikidata.initialize()

// produces a Visjs time string from a Wikidata value/precision time object
function produceVisjsTime(inTime)
{
	if (!inTime.value)
	{
		// missing value
		//TODO: display open-ended
		return moment().format("YYYYYY-MM-DDT00:00:00")
	}

	// vis.js has trouble with negative years unless they're six digits
	const date = moment.utc(inTime.value, 'YYYYYY-MM-DDThh:mm:ss')

	//TODO: do something nice in the GUI to indicate imprecision of times
	switch (inTime.precision)
	{
		case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 7: case 8: case 9:
			const yearBase = Math.pow(10, 9 - inTime.precision)
			const roundedYear = Math.round(date.year() / yearBase) * yearBase
			const yearString = Math.abs(roundedYear).toFixed(0).padStart(6, "0")
			const sign = roundedYear < 0 ? '-' : '+';
			return `${sign}${yearString}-01-01T00:00:00`
		case 10: // month precision
			return date.format("YYYYYY-MM-01T00:00:00")
		case 11: // day precision
			return date.format("YYYYYY-MM-DDT00:00:00")
		case 12: // hour precision
			return date.format("YYYYYY-MM-DDThh:00:00")
		case 13: // minute precision
			return date.format("YYYYYY-MM-DDThh:mm:00")
		case 14: // second precision
			return date.format("YYYYYY-MM-DDThh:mm:ss")
		default:
			throw `Unrecognized date precision ${inTime.precision}`
	}
}

// produces JSON output from the queried data
function produceOutput(items)
{
	var outputObject = { items: [], groups: inputSpec.groups, options: inputSpec.options }
	for (const item of items)
	{
		var outputItem = {
			id: item.id,
			content: item.label,
			className: item.className,
			comment: item.comment,
			type: item.type
		}
		if (item.start)
			outputItem.start = produceVisjsTime(item.start)
		if (item.end)
			outputItem.end = produceVisjsTime(item.end)
		if (item.group)
		{
			outputItem.group = item.group
			outputItem.subgroup = item.entity
		}
		
		outputObject.items.push(outputItem)
	}
	return JSON.stringify(outputObject, undefined, "\t") //TODO: configure space
}

async function entryPoint() {}

entryPoint()
.then(async () => {

	// load the wikidata cache
	try
	{
		await wikidata.readCache();
	}
	catch
	{
		// cache doesn't exist or is invalid; continue without it
	}

})
.then(async () => {

	// replace template items using their item-generating queries
	for (var i = inputSpec.items.length - 1; i >= 0; --i)
	{
		var templateItem = inputSpec.items[i]
		if (templateItem.itemQuery)
		{
			inputSpec.items.splice(i, 1)
			const newItems = await wikidata.createTemplateItems(templateItem)
			for (const newItem of newItems)
				inputSpec.items.push(newItem)
		}
	}

})
.then(() => {

	var hasError = false;

	// collect all existing ids
	var itemIds = new Set()
	for (const item of inputSpec.items)
	{
		if (item.id)
		{
			if (itemIds.has(item.id))
			{
				itemIds.add(item.id)
			}
			else
			{
				console.error(`Item id '${item.id}' appears multiple times.`)
				hasError = true
			}
		}
	}

	// generate ids for items that don't have one
	for (const item of inputSpec.items)
	{
		if (!item.id)
		{
			const baseId = item.entity ? item.entity : "anonymous"
			var i = 0
			do {
				i++
				var prospectiveId = baseId + "-" + i
			} while (itemIds.has(prospectiveId));
			item.id = prospectiveId
			itemIds.add(prospectiveId)
		}
	}

	if (hasError) throw "Error generating item ids."

})
.then(() => {
	
	// batch up queries using templates
	//TODO:

})
.then(async () => {

	// run all the Wikidata queries
	for (const item of inputSpec.items)
	{
		if (item.finished) continue

		console.log(`Processing ${item.id}...`)

		//TODO: batch queries on the same item

		if (item.startQuery)
			item.start = await wikidata.runTimeQueryTerm(item.startQuery, item)
		if (item.endQuery)
			item.end = await wikidata.runTimeQueryTerm(item.endQuery, item)
		item.finished = true
	}

})
.then(async () => {

	await mypath.ensureDirectoryForFile(outputFile)

	// write the output file
	const output = produceOutput(inputSpec.items)
	await fs.writeFile(outputFile, output, err => {
		if (err) {
			console.error(`Error writing output file:`)
			console.error(err)
		}
	});

})
.catch((reason) => {

	console.error(reason)

})
.finally(async () => { await wikidata.writeCache(); })
