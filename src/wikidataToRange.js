
const moment = require('moment')

const wikidataToMomentPrecision = [
	undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
	'year', 'month', 'day', 'hour', 'minute', 'second'
]

/**
 * Produces a range of moments from a Wikidata time.
 * @param {*} inTime {value,precision}
 * @param {*} maxUncertainPrecision Max Wikidata precision to treat as uncertain.
 * @returns {*} {min,max}
 */
module.exports = function wikidataToRange(inTime, maxUncertainPrecision)
{
	if (!inTime || !inTime.value)
	{
		// missing value
		return undefined
	}

	if (maxUncertainPrecision === undefined) maxUncertainPrecision = 10

	// moment has trouble with negative years unless they're six digits
	const date = moment(inTime.value, 'YYYYYY-MM-DDThh:mm:ss')

	switch (inTime.precision)
	{
		case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 7: case 8:
			const yearBase = Math.pow(10, 9 - inTime.precision)
			var roundedYear = Math.floor(date.year() / yearBase) * yearBase

			// correct for lack of year 0 ("-19" is actually "-20 BC")
			// and also for the fact that "-20 BC" is really on the positive side of e.g. -18
			if (date.year() < 0) roundedYear += 2

			return {
				min: moment({year:roundedYear}),
				max: moment({year:roundedYear + yearBase}).subtract(1, 'minute').endOf('year')
			}
		default:
			if (inTime.precision > maxUncertainPrecision)
			{
				const momentPrecision = wikidataToMomentPrecision[inTime.precision]
				return { min: date.clone().startOf(momentPrecision), max: date.clone().startOf(momentPrecision) }
			}
			else if (inTime.precision < wikidataToMomentPrecision.length)
			{
				const momentPrecision = wikidataToMomentPrecision[inTime.precision]
				return { min: date.clone().startOf(momentPrecision), max: date.clone().endOf(momentPrecision) }
			}
			else
			{
				throw `Unrecognized date precision ${inTime.precision}`
			}
	}
}
