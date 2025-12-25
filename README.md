# vis-chronicle

vis-chronicle is a tool to generate web-based timelines from Wikidata SPARQL queries. You feed the tool a specification JSON file that describes what items to put on the timeline. The tool gathers the needed data from Wikidata and produces a JSON file suitable for feeding directly to [vis-timeline](https://github.com/visjs/vis-timeline).

[vis-chronicle-demo](https://github.com/BrianMacIntosh/vis-chronicle-demo) is a demo application using this tool.

## Example

This specification file generates a timeline containing the lifespans of every United States president.

```json
{
	"groups":
	[
		{
			"id": "presidents",
			"content": ""
		}
	],
	"options":
	{
		"width": "100%",
		"preferZoom": false,
		"showCurrentTime": true,
		"stack": false,
		"stackSubgroups": false,
		"verticalScroll": true
	},
	"queryTemplates":
	{
		"dateOfBirth": "{entity} p:P569 {_OUT}.",
		"dateOfDeath": "{entity} p:P570 {_OUT}."
	},
	"items":
	[
		{
			"comment": "All United States presidents",
			"itemQuery": "{_OUT} wdt:P39 wd:Q11696. {_OUT} wdt:P31 wd:Q5.",
			"group": "presidents",

			"startQuery": "#dateOfBirth",
			"endQuery": "#dateOfDeath"
		},
		{
			"label": "Ed Kealty (fictional)",
			"entity": "Q5335019",
			"group": "presidents",
			"startQuery": "#dateOfBirth",
			"endQuery": "#dateOfDeath"
		}
	]
}

```

`groups` and `options` are transparently passed through for vis-timeline - see the vis-timeline documentation. `"stack": false` and `"stackSubgroups": false` false are necessary in order for chronicle's open-ended ranges to display correctly.

`queryTemplates` contains template queries to be re-used by multiple items. vis-chronicle comes with a few template queries by default. Queries need to match a property (`p:`) using the variable `?_prop` and a value (such as `psv:` or `pqv:`) using the variable `?_value`. Also, any format variable like `{format}` will be replaced by the same-named value on the item entry, allowing templates to be parameterized.

`items` contains any number of items to generate. An item can be a single, literal item, or a multi-item generator (using `itemQuery`).

Item properties:
* `label`: Literal items only. Display label for the item. Can contain HTML. For generators, `{_LABEL}` will be replaced by the Wikidata label.
* `itemQuery`: Generators only. A SPARQL query segment to select all the items that should be generated. `{_OUT}` stands in for the ouput variable. The `entity` property is added to each item with the item's entity id. Item labels are automatically fetched from Wikidata.
* `group`: The vis-timeline group to put the item(s) in.
* `className`: CSS class to apply to the timeline div.
* `type`: vis-timeline type of the item.
* `startQuery`: A SPARQL query segment that selects the desired start time of the object. These should select Wikidata properties (not statements or values). Can be a query term like `Q5335019 p:P569 {_OUT}.` or a template query like `#dateOfBirth`.
* `endQuery`: Same as `startQuery`, but for the end time.
* `expectedDuration`: Describes the expected duration, for hinting if the start or end is missing.
    * `min`: The absolute minimum duration.
	* `max`: The absolute maximum duration.
	* `avg`: The average duration.

## Parameters

The tool can be run as a package script like `vis-chronicle ./src/timeline.json -v`.

The tool takes these parameters on the command line:
* (Mandatory) The name of the input file.
* (Optional) The name of the output file. Defaults to `intermediate/timeline.json`.
* `-v[erbose]`: Print verbose output, including the actual queries being run.
* `-skip-wd-cache`: Do not read anything from the local cache, query all data fresh.
* `-q[uery-url]`: The URL of the SPARQL endpoint. Defaults to `https://query.wikidata.org/sparql`.
* `-l[ang]`: Language priorities to use when fetching labels. Defaults to `en,mul`. See (SPARQL/SERVICE - Label)[https://en.wikibooks.org/wiki/SPARQL/SERVICE_-_Label].
