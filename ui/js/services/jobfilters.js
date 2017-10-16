'use strict';

/**
   This service handles whether or not a job, job group or platform row should
   be displayed based on the filter settings.

   Global filter settings are stored and updated here.  But this also provides
   helper methods for individual resultsets.
*/

/**
 * Filters can be specific to the resultStatus.  But we can also have filters
 * for things like slavename, job type, job group, platform, etc.  This allows
 *
 * rules:
 * ======
 * For a job to be shown, it must have a matching value in ALL the fields
 * specified (including defaults).  But if a field has multiple values, then it
 * must match only ONE of those values.
 */
treeherder.factory('thJobFilters', [
    'thResultStatusList', 'ThLog', '$rootScope', '$location',
    'thNotify', 'thEvents', 'thFailureResults',
    'thResultStatus', 'thClassificationTypes', 'ThRepositoryModel',
    'thPlatformName',
    function (
        thResultStatusList, ThLog, $rootScope, $location,
        thNotify, thEvents, thFailureResults,
        thResultStatus, thClassificationTypes, ThRepositoryModel,
        thPlatformName) {

        const $log = new ThLog("thJobFilters");

        // prefix for all filter query string params
        const PREFIX = "filter-";

        // constants for specific types of filters
        const CLASSIFIED_STATE = "classifiedState";
        const RESULT_STATUS = "resultStatus";
        const SEARCH_STR = "searchStr";

        const QS_CLASSIFIED_STATE = PREFIX + CLASSIFIED_STATE;
        const QS_RESULT_STATUS = PREFIX + RESULT_STATUS;
        const QS_SEARCH_STR = PREFIX + SEARCH_STR;

        // default filter values, when a filter is not specified in the query string
        const DEFAULTS = {
            resultStatus: thResultStatusList.defaultFilters(),
            classifiedState: ['classified', 'unclassified'],
            tier: ["1", "2"]
        };

        let NON_FIELD_FILTERS = ['fromchange', 'tochange', 'author',
            'nojobs', 'startdate', 'enddate', 'revision'];

        // failure classification ids that should be shown in "unclassified" mode
        const UNCLASSIFIED_IDS = [1, 7];

        const TIERS = ["1", "2", "3"];

        // used with field-filters to determine how to match the value against the
        // job field.
        const MATCH_TYPE = {
            exactstr: 'exactstr',
            substr: 'substr', // returns true if any values match the substring
            searchStr: 'searchStr', // returns true only if ALL the values match the substring
            choice: 'choice'
        };

        // choices available for the field filters
        const FIELD_CHOICES = {
            ref_data_name: {
                name: "buildername/jobname",
                matchType: MATCH_TYPE.substr
            },
            build_system_type: {
                name: "build system",
                matchType: MATCH_TYPE.substr
            },
            job_type_name: {
                name: "job name",
                matchType: MATCH_TYPE.substr
            },
            job_type_symbol: {
                name: "job symbol",
                matchType: MATCH_TYPE.exactstr
            },
            job_group_name: {
                name: "group name",
                matchType: MATCH_TYPE.substr
            },
            job_group_symbol: {
                name: "group symbol",
                matchType: MATCH_TYPE.exactstr
            },
            machine_name: {
                name: "machine name",
                matchType: MATCH_TYPE.substr
            },
            platform: {
                name: "platform",
                matchType: MATCH_TYPE.substr
            },
            tier: {
                name: "tier",
                matchType: MATCH_TYPE.exactstr
            },
            failure_classification_id: {
                name: "failure classification",
                matchType: MATCH_TYPE.choice,
                choices: thClassificationTypes.classifications
            },
            // text search across multiple fields
            searchStr: {
                name: "search string",
                matchType: MATCH_TYPE.searchStr
            }
        };

        // filter caches so that we only collect them when the filter params
        // change in the query string
        let cachedResultStatusFilters = {};
        let cachedClassifiedStateFilters = {};
        let cachedFieldFilters = {};
        let cachedFilterParams;

        /**
         * Checks for a filter change and, if detected, updates the cached filter
         * values from the query string.  Then publishes the global event
         * to re-render jobs.
         */
        $rootScope.$on('$locationChangeSuccess', function () {

            const newFilterParams = getNewFilterParams();
            if (!_.isEqual(cachedFilterParams, newFilterParams)) {
                cachedFilterParams = newFilterParams;
                _refreshFilterCaches();
                $rootScope.$emit(thEvents.globalFilterChanged);
            }

        });

        function getNewFilterParams() {
            return _.pickBy($location.search(), function (value, field) {
                return field.startsWith(PREFIX);
            });
        }

        function _refreshFilterCaches() {
            cachedResultStatusFilters = _getFiltersOrDefaults(RESULT_STATUS);
            cachedClassifiedStateFilters = _getFiltersOrDefaults(CLASSIFIED_STATE);
            cachedFieldFilters = getFieldFiltersObj();
        }

        function getFieldFiltersObj() {
            let fieldFilters = {};
            // get the search params and lay any defaults over it so we test
            // against those as well.
            const locationSearch = _.defaults(_.clone($location.search()),
                                            _.mapKeys(DEFAULTS, function (value, key) {
                                                return _withPrefix(key);
                                            }));
            _.each(locationSearch, function (values, field) {
                if (_isFieldFilter(field)) {
                    if (field === QS_SEARCH_STR) {
                        // we cache this one a little differently
                        fieldFilters[_withoutPrefix(field)] = decodeURIComponent(values).replace(/ +(?= )/g, ' ').toLowerCase().split(' ');
                    } else {
                        fieldFilters[_withoutPrefix(field)] = _.map(
                            _toArray(values), v => String(v).toLowerCase());
                    }
                }
            });
            return fieldFilters;
        }

        function _getFiltersOrDefaults(field) {
            // NON_FIELD_FILTERS are filer params that don't have the prefix
            const qsField = NON_FIELD_FILTERS.includes(field) ? _withoutPrefix(field) : _withPrefix(field);
            const filters = _.clone($location.search()[qsField]);
            if (filters) {
                return _toArray(filters);
            } else if (DEFAULTS.hasOwnProperty(_withoutPrefix(field))) {
                return DEFAULTS[_withoutPrefix(field)].slice();
            }
            return [];
        }

        /**
         * Whether or not this job should be shown based on the current
         * filters.
         *
         * @param job - the job we are checking against the filters
         */
        function showJob(job) {
            // when runnable jobs have been added to a resultset, they should be
            // shown regardless of settings for classified or result state
            if (job.result !== "runnable") {
                // test against resultStatus and classifiedState
                if (!_.includes(cachedResultStatusFilters, thResultStatus(job))) {
                    return false;
                }
                if (!_checkClassifiedStateFilters(job)) {
                    return false;
                }
            }
            // runnable or not, we still want to apply the field filters like
            // for symbol, platform, search str, etc...
            return _checkFieldFilters(job);
        }

        function _checkClassifiedStateFilters(job) {
            const isClassified = _isJobClassified(job);
            if (!cachedClassifiedStateFilters.includes('unclassified') && !isClassified) {
                return false;
            }
            // If the filters say not to include classified, but it IS
            // classified, then return false, otherwise, true.
            return !(!cachedClassifiedStateFilters.includes('classified') && isClassified);
        }

        function _checkFieldFilters(job) {

            for (let field in cachedFieldFilters) {
                if (cachedFieldFilters.hasOwnProperty(field)) {

                    const values = cachedFieldFilters[field];
                    let jobFieldValue = _getJobFieldValue(job, field);

                    if (!_.isUndefined(jobFieldValue)) {
                        // if a filter is added somehow, but the job object doesn't
                        // have that field, then don't filter.  Consider it a pass.
                        jobFieldValue = String(jobFieldValue).toLowerCase();

                        switch (FIELD_CHOICES[field].matchType) {

                            case MATCH_TYPE.substr:
                                if (!_containsSubstr(values, jobFieldValue)) {
                                    return false;
                                }
                                break;

                            case MATCH_TYPE.searchStr:
                                if (!_containsAllSubstr(values, jobFieldValue)) {
                                    return false;
                                }
                                break;

                            case MATCH_TYPE.exactstr:
                                if (!_.includes(values, jobFieldValue)) {
                                    return false;
                                }
                                break;

                            case MATCH_TYPE.choice:
                                if (!_.includes(values, jobFieldValue)) {
                                    return false;
                                }
                                break;
                        }
                    }
                }
            }

            return true;
        }

        function addFilter(field, value) {
            //check for existing value
            const oldQsVal = _getFiltersOrDefaults(field);
            let newQsVal = null;

            // All filters support multiple values except NON_FIELD_FILTERS.
            if (oldQsVal && !NON_FIELD_FILTERS.includes(field)) {
                // set the value to an array
                newQsVal = _toArray(oldQsVal);
                newQsVal.push(value);
                newQsVal = _.uniq(newQsVal);
            } else {
                newQsVal = value;
            }
            if (_matchesDefaults(field, newQsVal)) {
                newQsVal = null;
            }
            $log.debug("add set " + _withPrefix(field) + " from " + oldQsVal + " to " + newQsVal);
            $location.search(_withPrefix(field), newQsVal);
        }

        function removeFilter(field, value) {
            // default to just removing the param completely
            let newQsVal = null;

            if (value) {
                const oldQsVal = _getFiltersOrDefaults(field);
                if (oldQsVal && oldQsVal.length) {
                    newQsVal = _.without(oldQsVal, value);
                }
                if (!newQsVal || !newQsVal.length || _matchesDefaults(field, newQsVal)) {
                    newQsVal = null;
                }
                $log.debug("remove set " + _withPrefix(field) + " from " + oldQsVal + " to " + newQsVal);
            }
            $location.search(_withPrefix(field), newQsVal);
        }

        function replaceFilter(field, value) {
            //check for existing value
            $log.debug("add set " + _withPrefix(field) + " to " + value);
            $location.search(_withPrefix(field), value);
        }

        function removeAllFieldFilters() {
            const locationSearch = $location.search();
            _stripFieldFilters(locationSearch);
            $location.search(locationSearch);
        }

        /**
         * reset the non-field (checkbox in the ui) filters to the default state
         * so the user sees everything.  Doesn't affect the field filters.  This
         * is used to undo the call to ``setOnlyUnclassifiedFailures``.
         */
        function resetNonFieldFilters() {
            const locationSearch = _.clone($location.search());
            delete locationSearch[QS_RESULT_STATUS];
            delete locationSearch[QS_CLASSIFIED_STATE];
            $location.search(locationSearch);
        }

        /**
         * used mostly for resultStatus doing group toggles
         *
         * @param field
         * @param values - an array of values for the field
         * @param add - true if adding, false if removing
         */
        function toggleFilters(field, values, add) {
            $log.debug("toggling to ", add);
            const action = add ? addFilter : removeFilter;
            values.map(value => action(field, value));
            // Don't emit the filter changed state here: we'll
            // do that when the URL change signal gets fired (see
            // the locationChangeSuccess event, above)
        }

        function toggleInProgress() {
            toggleResultStatuses(['pending', 'running']);
        }

        function toggleResultStatuses(resultStatuses) {
            let rsValues = _getFiltersOrDefaults(RESULT_STATUS);
            if (_.difference(resultStatuses, rsValues).length === 0) {
                rsValues = _.difference(rsValues, resultStatuses);
            } else {
                rsValues = _.uniq(rsValues.concat(resultStatuses));
            }
            // remove all query string params for this field if we match the defaults
            if (_matchesDefaults(RESULT_STATUS, rsValues)) {
                rsValues = null;
            }
            $location.search(QS_RESULT_STATUS, rsValues);
        }

        function toggleUnclassifiedFailures() {
            $log.debug("toggleUnclassifiedFailures");
            if (_isUnclassifiedFailures()) {
                resetNonFieldFilters();
            } else {
                setOnlyUnclassifiedFailures();
            }
        }

        function isFilterSetToShow(field, value) {
            return _.includes(_getFiltersOrDefaults(field), String(value));
        }

        /**
         * Set the non-field filters so that we only view unclassified failures
         */
        function setOnlyUnclassifiedFailures() {
            const locationSearch = _.clone($location.search());
            locationSearch[QS_RESULT_STATUS] = thFailureResults.slice();
            locationSearch[QS_CLASSIFIED_STATE] = ['unclassified'];
            $location.search(locationSearch);
        }

        /**
         * Set the non-field filters so that we only view superseded jobs
         */
        function setOnlySuperseded() {
            const locationSearch = _.clone($location.search());
            locationSearch[QS_RESULT_STATUS] = "superseded";
            locationSearch[QS_CLASSIFIED_STATE]= DEFAULTS.classifiedState.slice();
            $location.search(locationSearch);
        }

        function getClassifiedStateArray() {
            const arr = _toArray($location.search()[QS_CLASSIFIED_STATE]) ||
                DEFAULTS.classifiedState;
            return arr.slice();
        }

        /**
         * Used externally to display the field filters.  Internally, we treat
         * the ``searchStr`` as a field filter, but the we don't want to expose
         * that outside of this class in this function.
         */
        function getFieldFiltersArray() {
            const fieldFilters = [];
            const clopt = thClassificationTypes.classificationOptions;

            _.each($location.search(), function (values, fieldName) {
                if (_isFieldFilter(fieldName)) {
                    const valArr = _toArray(values);
                    _.each(valArr, function (val, index) {
                        if (fieldName !== QS_SEARCH_STR) {
                            fieldFilters.push({
                                field: _withoutPrefix(fieldName),
                                value: val,
                                key: fieldName
                            });
                            // Convert classification type int to equivalent string for the UI
                            if (fieldFilters[index].field === 'failure_classification_id') {
                                for (var i = 0; i < clopt.length; i++) {
                                    // console.log(clopt[i]['id']);
                                    // console.log(clopt[i]['name']);
                                    // console.log(fieldFilters[0].value);
                                    if (clopt[i]['id'].toString() === fieldFilters[index].value) {
                                        // console.log(clopts[i]['name']);
                                        fieldFilters[index].text = clopt[i]['name'];
                                    }
                                }
                                // console.log(clopts);
                                // console.log(clopts[2]['name']);
                            }
                        }
                        // console.log(fieldFilters[0].value);
                        // console.log(fieldFilters[0].field);
                    });
                }
            });
            // console.log(fieldFilters);
            return fieldFilters;
        }

        function getNonFieldFiltersArray() {
            return Object.entries($location.search()).reduce((acc, [key, value]) => (
                NON_FIELD_FILTERS.includes(key) ? [...acc, { field: key, key, value }]: acc
            ), []);
        }

        function getFieldChoices() {
            const choices = _.clone(FIELD_CHOICES);
            delete choices.searchStr;
            return choices;
        }

        function getResultStatusArray() {
            const arr = _toArray($location.search()[QS_RESULT_STATUS]) ||
                DEFAULTS.resultStatus;
            return arr.slice();
        }

        function isJobUnclassifiedFailure(job) {
            return (_.includes(thFailureResults, job.result) &&
                    !_isJobClassified(job));
        }

        function _isJobClassified(job) {
            return !_.includes(UNCLASSIFIED_IDS, job.failure_classification_id);
        }

        function stripFiltersFromQueryString(locationSearch) {
            delete locationSearch[QS_CLASSIFIED_STATE];
            delete locationSearch[QS_RESULT_STATUS];

            _stripFieldFilters(locationSearch);
            return locationSearch;
        }

        /**
         * Removes field filters from the passed-in locationSearch without
         * actually setting it in the location bar
         */
        function _stripFieldFilters(locationSearch) {
            _.forEach(locationSearch, function (val, field) {
                if (_isFieldFilter(field)) {
                    delete locationSearch[field];
                }
            });
            return locationSearch;
        }

        function _isFieldFilter(field) {
            return field.startsWith(PREFIX) &&
                !_.includes(['resultStatus', 'classifiedState'], _withoutPrefix(field));
        }

        /**
         * Get the field from the job.  In most cases, this is very simple.  But
         * this function allows for some special cases, like ``platform`` which
         * shows to the user as a different string than what is stored in the job
         * object.
         */
        function _getJobFieldValue(job, field) {
            // area of interest
            if (field === 'platform') {
                return thPlatformName(job[field]) + " " + job.platform_option;
            } else if (field === 'searchStr') {
                // lazily get this to avoid storing redundant information
                return job.get_search_str();
            }

            return job[field];
        }

        /**
         * check if we're in the state of showing only unclassified failures
         */
        function _isUnclassifiedFailures() {
            return (_.isEqual(_toArray($location.search()[QS_RESULT_STATUS]), thFailureResults) &&
                    _.isEqual(_toArray($location.search()[QS_CLASSIFIED_STATE]), ['unclassified']));
        }

        function _matchesDefaults(field, values) {
            $log.debug("_matchesDefaults", field, values);
            field = _withoutPrefix(field);
            if (DEFAULTS.hasOwnProperty(field)) {
                return values.length === DEFAULTS[field].length &&
                    _.intersection(DEFAULTS[field], values).length === DEFAULTS[field].length;
            }
            return false;
        }

        function _withPrefix(field) {
            return (!field.startsWith(PREFIX) && !NON_FIELD_FILTERS.includes(field)) ? PREFIX+field : field;
        }

        function _withoutPrefix(field) {
            return field.startsWith(PREFIX) ? field.replace(PREFIX, '') : field;
        }

        /**
         * Check the array if any elements contain a match for the ``val`` as a
         * substring.  These functions exist so we aren't creating functions
         * in a loop.
         */
        function _containsSubstr(arr, val) {
            return arr.some(arVal => val.includes(arVal));
        }

        function _containsAllSubstr(arr, val) {
            return arr.every(arVal => val.includes(arVal));
        }

        function _toArray(value) {
            if (_.isUndefined(value)) {
                return value;
            }
            if (!_.isArray(value)) {
                return [value];
            }
            return value;
        }

        // initialize caches on initial load
        cachedFilterParams = getNewFilterParams();
        _refreshFilterCaches();

        // returns active filters starting with the prefix
        function getActiveFilters() {
            const filters = {};
            Object.keys($location.search()).forEach(function (key) {
                if (key.startsWith(PREFIX)) {
                    filters[key] = $location.search()[key];
                }
            });
            return filters;
        }

        /*********************************
         * Externally available API fields
         */

        return {
            // check a job against the filters
            showJob: showJob,

            // filter changing accessors
            addFilter: addFilter,
            removeFilter: removeFilter,
            replaceFilter: replaceFilter,
            removeAllFieldFilters: removeAllFieldFilters,
            resetNonFieldFilters: resetNonFieldFilters,
            toggleFilters: toggleFilters,
            toggleResultStatuses: toggleResultStatuses,
            toggleInProgress: toggleInProgress,
            toggleUnclassifiedFailures: toggleUnclassifiedFailures,
            setOnlySuperseded: setOnlySuperseded,
            getActiveFilters: getActiveFilters,

            // filter data read-only accessors
            getClassifiedStateArray: getClassifiedStateArray,
            getNonFieldFiltersArray: getNonFieldFiltersArray,
            getFieldFiltersArray: getFieldFiltersArray,
            getFieldFiltersObj: getFieldFiltersObj,
            getResultStatusArray: getResultStatusArray,
            isJobUnclassifiedFailure: isJobUnclassifiedFailure,
            isFilterSetToShow: isFilterSetToShow,
            stripFiltersFromQueryString: stripFiltersFromQueryString,
            getFieldChoices: getFieldChoices,

            // CONSTANTS
            classifiedState: CLASSIFIED_STATE,
            resultStatus: RESULT_STATUS,
            tiers: TIERS
        };
    }]);
