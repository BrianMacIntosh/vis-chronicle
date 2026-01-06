
const moment = require('moment')
const assert = require('node:assert/strict');
const globalData = require("./global-data.json")

function postprocessDuration(duration)
{
	if (duration.min)
		duration.min = moment.duration(duration.min)
	if (duration.max)
		duration.max = moment.duration(duration.max)
	if (duration.avg)
		duration.avg = moment.duration(duration.avg)
	return duration
}
function postprocessGlobalData()
{
	for (const expectation of globalData.expectations)
	{
		if (expectation.duration)
		{
			postprocessDuration(expectation.duration)
		}
	}
}
postprocessGlobalData()

const renderer = {}

renderer.getExpectation = function(item)
{
	if (item.expectedDuration)
	{
		return { "duration": item.expectedDuration };
	}

	for (const expectation of globalData.expectations)
	{
		if (expectation.startQuery && item.startQuery != expectation.startQuery)
		{
			continue;
		}
		if (expectation.endQuery && item.endQuery != expectation.endQuery)
		{
			continue;
		}
		if (expectation.startEndQuery && item.startEndQuery != expectation.startEndQuery)
		{
			continue;
		}
		return expectation;
	}
	assert(false) // expect at least a universal fallback expectation
	return undefined
}

// produces JSON output from the queried data
renderer.produceOutput = function(inputSpec, items)
{
	console.log("Producing output...")
	
	const finalizeItem = function(item)
	{
		assert(item.start)
		item.start = item.start.format("YYYYYY-MM-DDThh:mm:ss")
		if (item.end)
			item.end = item.end.format("YYYYYY-MM-DDThh:mm:ss")
		outputObject.items.push(item)
	}

	// group items with prev/next data into prev/next chains
	//TODO: also use 'series ordinal' property for hinting
	const successionChains = []
	for (const item of items)
	{
		// try to append to an existing chain
		//TODO: does not support branching chains
		var nextForChain = null
		var prevForChain = null
		for (const chain of successionChains)
		{
			if ((item.next && item.next == chain[0].entity)
				&& (chain[0].previous && item.entity == chain[0].previous))
			{
				prevForChain = chain
			}
			if ((item.previous && item.previous == chain.at(-1).entity)
				&& (chain.at(-1).next && item.entity == chain.at(-1).next))
			{
				nextForChain = chain
			}
		}

		if (nextForChain && prevForChain)
		{
			// merge chains
			nextForChain.push(item)
			if (nextForChain != prevForChain) //wtf
			{
				for (const prevItem of prevForChain) nextForChain.push(prevItem)
				const prevForChainIdx = successionChains.indexOf(prevForChain)
				successionChains.splice(prevForChainIdx, 1)
			}
		}
		else if (nextForChain)
		{
			nextForChain.push(item)
		}
		else if (prevForChain)
		{
			prevForChain.unshift(item)
		}
		else
		{
			successionChains.push([ item ])
		}

		// DEBUG: validate
		/*for (const chain of successionChains)
		{
			for (var i2 = 0; i2 < chain.length - 1; i2++)
			{
				assert(chain[i2].entity == chain[i2+1].previous)
			}
			for (var i2 = 1; i2 < chain.length; i2++)
			{
				assert(chain[i2].entity == chain[i2-1].next)
			}
		}*/
	}

	// split overlapped uncertain regions between adjacent items
	//TODO: create a shared area that visually makes it more clear that the line can slide around?
	//TODO: handle multiple entire elements that overlap
	for (const chain of successionChains)
	{
		for (var chainIndex = 0; chainIndex < chain.length - 1; chainIndex++)
		{
			var curr = chain[chainIndex]
			var next = chain[chainIndex + 1]
			if (!curr.end_min || !next.start_min) continue
			var overlapStart = moment.max(curr.end_min, next.start_min)
			var overlapEnd = moment.min(curr.end_max, next.start_max)
			if (overlapStart < overlapEnd)
			{
				var middle = moment((overlapStart.valueOf() + overlapEnd.valueOf()) / 2)
				curr.end_max = middle.clone()
				next.start_min = middle.add(1, 'second')
			}
		}
	}

	// create timeline items
	// a single input item might be built of multiple timeline segments
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
		if (item.group)
		{
			outputItem.group = item.group
			outputItem.subgroup = item.subgroup ? item.subgroup : item.entity
		}

		const isRangeType = !outputItem.type || outputItem.type == "range" || outputItem.type == "background"

		// for debugging
		outputItem.className = [ outputItem.className, item.entity ].join(' ')
		
		// look up duration expectations
		const expectation = this.getExpectation(item)
		expectation.duration.avg = expectation.duration.avg ?? expectation.duration.max
		assert(expectation && expectation.duration) // expect at least a universal fallback expectation

		if (!item.start_min && !item.start_max && !item.end_min && !item.end_max)
		{
			//console.warn(`Item ${item.id} has no date data at all.`)
			continue
		}
		assert(Boolean(item.start_min) == Boolean(item.start_max))
		assert(Boolean(item.end_min) == Boolean(item.end_max))
		assert(!(item.start_min > item.start_max))
		assert(!(item.end_min > item.end_max))

		// restrict uncertainty based on expectations
		//TODO:

		// exclude items that violate itemRange constraints
		//OPT: do this at an earlier stage? (e.g. when running the first query)
		if (item.itemRange)
		{
			if (item.itemRange.min && moment(item.itemRange.min).isAfter(item.end_max))
				continue
			if (item.itemRange.max && moment(item.itemRange.max).isBefore(item.start_min))
				continue
		}

		if (item.start_max >= item.end_min)
		{
			// no certainty at all: create a single uncertain range
			outputItem.className = [ outputItem.className, 'visc-uncertain' ].join(' ')
			outputItem.start = item.start_min
			outputItem.end = item.end_max

			finalizeItem(outputItem)
			continue
		}

		if (!isRangeType)
		{
			// point type
			//TODO: support ranged boxes etc?
			outputItem.start = moment((item.start_min.valueOf() + item.start_max.valueOf()) / 2)
			if (item.end_min && item.end_max)
				outputItem.end = moment((item.end_min.valueOf() + item.end_max.valueOf()) / 2)

			finalizeItem(outputItem)
			continue
		}

		// handle end date
		if (item.end_min && item.end_max)
		{
			if (item.end_min < item.end_max)
			{
				// uncertain end

				// find lower bound of uncertain region
				const uncertainMin = item.end_min ?? outputItem.start_max
				assert(uncertainMin)
				
				// add uncertain range
				outputObject.items.push({
					id: outputItem.id + "-unc-end",
					className: [outputItem.className, "visc-uncertain", "visc-left-connection"].join(' '),
					content: item.label ? "&nbsp;" : "",
					start: uncertainMin.format("YYYYYY-MM-DDThh:mm:ss"),
					end: item.end_max.format("YYYYYY-MM-DDThh:mm:ss"),
					group: item.group,
					subgroup: outputItem.subgroup
				})

				// adjust normal range to match
				outputItem.end = uncertainMin
				outputItem.className = [ outputItem.className, 'visc-right-connection' ].join(' ')
			}
			else
			{
				// certain end
				outputItem.end = item.end_max;
			}
		}
		else if (item.end_min && item.start_max < item.end_min)
		{
			// open-ended end with some certainty
			var tailEnd
			const useMax = expectation.duration.max ? expectation.duration.max : moment(expectation.duration.avg.asMilliseconds() * 2)
			if (item.start_max < moment().subtract(useMax))
			{
				// max "possible" is less than 'now'; it is likely this duration is not ongoing but has an unknown end
				//TODO: wikidata special 'no value' should cause the next branch to be taken
				outputItem.end = item.start_max.clone()
				tailEnd = item.start_max.clone().add(expectation.duration.avg)
			}
			else
			{
				// 'now' is within 'max' and so it is a reasonable guess that this duration is ongoing
				const avgDuration = moment.duration(expectation.duration.avg) //HACK: TODO: consistently postprocess expectations, or don't
				const actualDuration = moment.duration(moment().diff(item.start_max)) //TODO: average start here?
				var excessDuration = moment.duration(avgDuration.asMilliseconds()).subtract(actualDuration)
				excessDuration = moment.duration(Math.max(excessDuration.asMilliseconds(), avgDuration.asMilliseconds() * 0.25)) //HACK: magic number

				outputItem.end = moment()
				tailEnd = outputItem.end.add(excessDuration)
			}

			// add a "tail" item after the end
			outputObject.items.push({
				id: outputItem.id + "-tail",
				className: [outputItem.className, "visc-right-tail"].join(' '),
				content: item.label ? "&nbsp;" : "",
				start: outputItem.end.format("YYYYYY-MM-DDThh:mm:ss"),
				end: tailEnd.format("YYYYYY-MM-DDThh:mm:ss"),
				group: item.group,
				subgroup: outputItem.subgroup
			})

			outputItem.className = [ outputItem.className, 'visc-right-connection' ].join(' ')
		}
		else
		{
			if (item.start_min && item.start_max && item.start_max > item.start_min)
			{
				// entire range is open-ended, but with an uncertain start region
				outputItem.end = item.start_max.clone()
				tailEnd = item.start_max.clone().add(expectation.duration.avg)

				// add a "tail" item after the end
				outputObject.items.push({
					id: outputItem.id + "-tail",
					className: [outputItem.className, "visc-right-tail"].join(' '),
					content: item.label ? "&nbsp;" : "",
					start: outputItem.end.format("YYYYYY-MM-DDThh:mm:ss"),
					end: tailEnd.format("YYYYYY-MM-DDThh:mm:ss"),
					group: item.group,
					subgroup: outputItem.subgroup
				})

				outputItem.className = [ outputItem.className, 'visc-right-connection' ].join(' ')
			}
			else
			{
				// entire range is open-ended
				outputItem.start = item.start_min ?? item.start_max
				outputItem.end = outputItem.start.clone().add(expectation.duration.avg)
				outputItem.className = [ outputItem.className, 'visc-open-right' ].join(' ')
				finalizeItem(outputItem)
				continue
			}
		}
		
		// handle start date
		if (item.start_min && item.start_max)
		{
			if (item.start_max > item.start_min)
			{
				// uncertain start
				
				// find upper bound of uncertain region
				var uncertainMax
				if (item.start_max)
					uncertainMax = item.start_max
				else if (outputItem.start)
					uncertainMax = outputItem.start
				else
					uncertainMax = outputItem.end
				assert(uncertainMax)

				// add uncertain range
				outputObject.items.push({
					id: outputItem.id + "-unc-start",
					className: [outputItem.className, "visc-uncertain", "visc-right-connection"].join(' '),
					content: item.label ? "&nbsp;" : "",
					start: item.start_min.format("YYYYYY-MM-DDThh:mm:ss"),
					end: uncertainMax.format("YYYYYY-MM-DDThh:mm:ss"),
					group: item.group,
					subgroup: outputItem.subgroup
				})

				// adjust normal range to match
				//TODO: handle the entire range being uncertain
				outputItem.start = uncertainMax
				outputItem.className = [ outputItem.className, 'visc-left-connection' ].join(' ')
			}
			else
			{
				// certain start
				outputItem.start = item.start_min
			}
		}
		else if (!item.start_min)
		{
			// open-ended start
			outputItem.start = outputItem.end.clone().subtract(expectation.duration.avg)
			outputItem.className = [outputItem.className, "visc-open-left"].join(' ')
		}
		
		//TODO: missing death dates inside expected duration: solid to NOW, fade after NOW
		//TODO: accept expected durations and place uncertainly before/after those

		finalizeItem(outputItem)
	}

	// organize "subgroups" into interlocking rows
	// visjs can do this with stackSubgroups: false, but it's kind of twitchy,
	// so we'll do it statically here instead
	//TODO:

	delete outputObject.chronicle

	return JSON.stringify(outputObject, undefined, "\t") //TODO: configure space
}

module.exports = renderer
