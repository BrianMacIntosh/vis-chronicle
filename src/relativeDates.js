
const moment = require('moment')
const { toJewishDate, toGregorianDate, getIndexByJewishMonth } = require("jewish-date");

function momentToHDate(inMoment)
{
	return toJewishDate(inMoment.toDate()) //TODO: handle TZ/time of day
}

function HDateToMoment(inHDate)
{
	return moment(toGregorianDate(inHDate)) //TODO: handle TZ/time of day
}

function durationToWikidataPrecision(duration)
{
	if (duration.milliseconds()) return 14
	else if (duration.seconds()) return 14
	else if (duration.minutes()) return 13
	else if (duration.hours()) return 12
	else if (duration.days()) return 11
	else if (duration.months()) return 10
	else return 9
}

// Flattens a relative date string into a hard date string
module.exports = function flattenRelativeDate(wikidataCache, dateString)
{
	// parse out relative date components
	const relSplit = []
	const relExp = /[\+>][A-Za-z0-9\-]+/g
	var lastSep = 0
	while (true)
	{
		var match = relExp.exec(dateString)
		if (match)
		{
			relSplit.push(dateString.substring(lastSep, match.index))
		}
		else
		{
			relSplit.push(dateString.substring(lastSep))
			break
		}
		lastSep = match.index
	}

	if (!relSplit[0])
	{
		return null
	}
	else if (!wikidataCache[relSplit[0]])
	{
		console.error(`Date for '${relSplit[0]}' wasn't cached.`)
		return null
	}
	else
	{
		const cacheEntry = wikidataCache[relSplit[0]]
		if (relSplit.length > 1)
		{
			// handle relative segments of date
			// About precision:
			// - The actual value is assumed to lie in a range the size of the precision
			// - This start point can be more precise than the precision (e.g. a month starting on Oct 21)

			var momentDate = moment(cacheEntry.value, 'YYYYYY-MM-DDThh:mm:ss')
			var precision = cacheEntry.precision
			//console.log(momentDate)
			for (var i = 1; i < relSplit.length; i++)
			{
				const component = relSplit[i]
				if (component[0] == "+")
				{
					const momentDelta = moment.duration(component.substring(1))
					momentDate = momentDate.add(momentDelta)

					// addition durations can only reduce precision
					precision = Math.min(precision, durationToWikidataPrecision(momentDelta))
				}
				else if (component[0] == ">")
				{
					// advance to the start of the next occurrence of this month/day
					const componentSplit = component.substring(1).split('!')
					if (getIndexByJewishMonth(componentSplit[0]))
					{
						const hdate = momentToHDate(momentDate)
						if (hdate.monthName == componentSplit[0])
						{
							console.warn(`zdate (originally '${dateString}') is already in '${componentSplit[0]}'.`)
						}

						if (componentSplit[1])
						{
							// by day
							hdate.monthName = componentSplit[0]
							hdate.day = parseInt(componentSplit[1])
							precision = 11
						}
						else
						{
							// by month
							hdate.monthName = componentSplit[0]
							hdate.day = 1
							precision = 10
						}

						const candidate = HDateToMoment(hdate)
						if (candidate < momentDate)
						{
							hdate.year++
							momentDate = HDateToMoment(hdate)
						}
						else
						{
							momentDate = candidate
						}
					}
					else
					{
						console.error(`Cannot advance/'>' to '${componentVal}'.`)
					}
				}
				else
				{
					console.error(`Unsupported relative date operation '${component[0]}'.`)
				}

				//console.log(`${component} (${precision}): ${momentDate}`)
			}
			return {
				value: momentDate.format('YYYYYY-MM-DDThh:mm:ss'),
				precision: precision
			}
		}
		else
		{
			return {...cacheEntry}
		}
	}
}