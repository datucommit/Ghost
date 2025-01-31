// # STATE KEY Helper
// Usage: `{{state_key}}`
//

const sub2key = {
    'alabama': 'AL',
    'alaska': 'AK',
    'arizona': 'AZ',
    'arkansas': 'AR',
    'california': 'CA',
    'colorado': 'CO',
    'connecticut': 'CT',
    'delaware': 'DE',
    'districtofcolumbia': 'DC',
    'florida': 'FL',
    'georgia': 'GA',
    'hawaii': 'HI',
    'idaho': 'ID',
    'illinois': 'IL',
    'indiana': 'IN',
    'iowa': 'IA',
    'kansas': 'KS',
    'kentucky': 'KY',
    'louisiana': 'LA',
    'maine': 'ME',
    'maryland': 'MD',
    'massachusetts': 'MA',
    'michigan': 'MI',
    'minnesota': 'MN',
    'mississippi': 'MS',
    'missouri': 'MO',
    'montana': 'MT',
    'nebraska': 'NE',
    'nevada': 'NV',
    'newhampshire': 'NH',
    'newjersey': 'NJ',
    'newmexico': 'NM',
    'newyork': 'NY',
    'northcarolina': 'NC',
    'northdakota': 'ND',
    'ohio': 'OH',
    'oklahoma': 'OK',
    'oregon': 'OR',
    'pennsylvania': 'PA',
    'rhodeisland': 'RI',
    'southcarolina': 'SC',
    'southdakota': 'SD',
    'tennessee': 'TN',
    'texas': 'TX',
    'utah': 'UT',
    'vermont': 'VT',
    'virginia': 'VA',
    'washington': 'WA',
    'westvirginia': 'WV',
    'wisconsin': 'WI',
    'wyoming': 'WY',
    'puertorico': 'PR'
}

module.exports = function state_key() {
    return sub2key[process.env.subdomain];
};
