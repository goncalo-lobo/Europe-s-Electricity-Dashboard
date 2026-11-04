import pandas as pd

df_energy = pd.read_csv("./release_generation_yearly_lower.csv")
df_prices = pd.read_csv("./eurostat_prices.csv")

# Highest first Year Montenergro 2005 and then all below 2000
# Lowest last year Ukraine 2022 and the rest 2025

df_energy = df_energy[(df_energy["Year"] >= 2005) & (df_energy["Year"] <= 2025)].copy()


# Dropped evry YoY and Regions columns 

keep_cols_energy = [
    "Area", "Year", 
    "Electricity source","Generation (TWh)", "Share of generation (%)",
    'Emissions (MtCO2e)','Share of emissions (%)','Emissions intensity (gCO2e/kWh)'
]

# Renaming Features to be more readable and consistent with the rest of the code

df_energy = df_energy[keep_cols_energy].rename(columns={
    "Area": "country", "Year": "year",
    "Electricity source": "source",
    "Generation (TWh)": "generation_twh", "Share of generation (%)": "share_pct",
    "Emissions (MtCO2e)": "emissions_mtco2e",
    "Share of emissions (%)": "share_emissions_pct",
    "Emissions intensity (gCO2e/kWh)": "emissions_intensity_gco2e_kwh",
})

# Keeping only the necessary columns for the prices DataFrame
keep_cols_prices = [
    "Geopolitical entity (reporting)", "TIME_PERIOD","OBS_VALUE"
]

# Renaming Features to be more readable and consistent with the rest of the code

df_prices = df_prices[keep_cols_prices].rename(columns={
    "Geopolitical entity (reporting)": "country", "TIME_PERIOD": "time", "OBS_VALUE": "price_eur_kwh"
})

# Only kept the following hierarchy:
#                                                                Demand                                 |
#                                             Total Generation                              | Net Import| 
#                                Clean                          |            Fossil         |           |
#                      Renewables                     |         |                           |           |
# Wind | Solar | Hydro | Bioenergy | Other Renewables | Nuclear | Coal | Gas | Other Fossil | Net Import|

keep_sources = [
    "Total generation", "Net imports", "Demand",
    "Clean", "Fossil", "Renewables", "Nuclear",
    "Wind", "Solar", "Hydro", "Bioenergy", "Other renewables",
    "Coal", "Gas", "Other fossil",
]

df_energy = df_energy[df_energy["source"].isin(keep_sources)].copy()

#-----------------------------Source hierarchy order-------------------------
hierarchy_order = [
    "Demand",
    "Total generation",
    "Net imports",
    "Clean",
    "Renewables",
    "Wind",
    "Solar",
    "Hydro",
    "Bioenergy",
    "Other renewables",
    "Nuclear",
    "Fossil",
    "Coal",
    "Gas",
    "Other fossil"
]

#-------------Rename countries to match between datasets-------------------------

df_prices['country'] = df_prices['country'].replace('Kosovo*', 'Kosovo')
df_energy['country'] = df_energy['country'].replace('Bosnia Herzegovina', 'Bosnia and Herzegovina')


#----------------------------------EU and Non-EU Aggregation-------------------------

numeric_cols = [
    'generation_twh', 'share_pct', 'emissions_mtco2e',
    'share_emissions_pct', 'emissions_intensity_gco2e_kwh'
]

eu_accession_year = {
    'Belgium': 1958, 'France': 1958, 'Germany': 1958, 'Italy': 1958,
    'Luxembourg': 1958, 'Netherlands': 1958,
    'Denmark': 1973, 'Ireland': 1973,
    'Greece': 1981,
    'Portugal': 1986, 'Spain': 1986,
    'Austria': 1995, 'Finland': 1995, 'Sweden': 1995,
    'Cyprus': 2004, 'Czechia': 2004, 'Estonia': 2004, 'Hungary': 2004,
    'Latvia': 2004, 'Lithuania': 2004, 'Malta': 2004, 'Poland': 2004,
    'Slovakia': 2004, 'Slovenia': 2004,
    'Bulgaria': 2007, 'Romania': 2007,
    'Croatia': 2013,
}
uk_membership = (1973, 2020)

def is_eu_member(country, year):
    if country == 'United Kingdom':
        return uk_membership[0] <= year < uk_membership[1]
    return eu_accession_year.get(country, 9999) <= year

all_countries = [c for c in df_energy['country'].unique() if c not in ['EU', 'EU2', 'Non-EU']]

def aggregate_region(df, region_name, membership_fn):
    base = df[df['country'].isin(all_countries)].copy()
    is_member = base.apply(lambda r: membership_fn(r['country'], r['year']), axis=1)
    subset = base[is_member]

    grouped = subset.groupby(['year', 'source'], as_index=False).agg(
        generation_twh=('generation_twh', 'sum'),
        emissions_mtco2e=('emissions_mtco2e', 'sum')
    )

    totals = grouped[grouped['source'] == 'Total generation'][
        ['year', 'generation_twh', 'emissions_mtco2e']
    ].rename(columns={'generation_twh': 'total_gen', 'emissions_mtco2e': 'total_emissions'})

    grouped = grouped.merge(totals, on='year', how='left')
    grouped['share_pct'] = grouped['generation_twh'] / grouped['total_gen'] * 100
    grouped['share_emissions_pct'] = grouped['emissions_mtco2e'] / grouped['total_emissions'] * 100
    grouped['emissions_intensity_gco2e_kwh'] = grouped['emissions_mtco2e'] / grouped['generation_twh'] * 1000

    grouped['country'] = region_name
    grouped['is_aggregated'] = True
    grouped = grouped.drop(columns=['total_gen', 'total_emissions'])
    return grouped[df.columns]

df_energy = df_energy[df_energy['country'] != 'EU'].reset_index(drop=True)

eu2 = aggregate_region(df_energy, 'EU', is_eu_member)
non_eu = aggregate_region(df_energy, 'Non-EU', lambda c, y: not is_eu_member(c, y))

df_energy = df_energy[~df_energy['country'].isin(['EU', 'Non-EU'])]
df_energy = pd.concat([df_energy, eu2, non_eu], ignore_index=True)


#----------------------------------country milestones export-------------------------
pivot = (
    df_energy[df_energy['source'].isin(['Renewables', 'Nuclear', 'Fossil'])]
    .pivot_table(
        index=['country', 'year'],
        columns='source',
        values='generation_twh',
        fill_value=0,  # países sem nuclear (ou outra fonte) contam como 0
    )
    .reset_index()
)

pivot['renewable_gt_rest'] = pivot['Renewables'] > (pivot['Nuclear'] + pivot['Fossil'])

milestones = (
    pivot[pivot['renewable_gt_rest']]
    .sort_values(['country', 'year'])
    .groupby('country', as_index=False)
    .first()[['country', 'year']]
    .rename(columns={'year': 'milestone_year'})
)

# Get all countries from the original data
all_countries = df_energy[['country']].drop_duplicates()

# Left join so countries without a milestone get NaN, then fill with -1
milestones = (
    all_countries
    .merge(milestones, on='country', how='left')
    .fillna({'milestone_year': -1})
    .astype({'milestone_year': int})
)

milestones.to_csv("../export/country_milestones.csv", index=False)

#-----------------------------------------------------------------------------------------

#round numbers to 3 decimals
df_energy = df_energy[['country', 'year', 'source', 'generation_twh', 'share_pct', 'emissions_intensity_gco2e_kwh']]
df_energy_rounded = df_energy.copy()

numeric_cols = ['generation_twh', 'share_pct', 'emissions_intensity_gco2e_kwh']

df_energy_rounded[numeric_cols] = df_energy_rounded[numeric_cols].round(3)

#sort by country, year and source according to the hierarchy order and export ggeneration by source data to csv

df_energy_rounded["source"] = pd.Categorical(df_energy_rounded["source"], categories=hierarchy_order, ordered=True)
df_energy_rounded = df_energy_rounded.sort_values(["country", "year", "source"]).reset_index(drop=True)


df_energy_rounded.to_csv("../export/generation_by_source_year.csv", index=False)

#---------------------------------------------------------------------------------------------

#-----------------------------prices data processing and export---------------------------------------------

df_uk = pd.read_csv("./uk_price_data1.csv")
df_uk['country'] = 'United Kingdom'


df_prices[['year', 'semester']] = df_prices['time'].str.split('-', expand=True)
df_prices['year'] = df_prices['year'].astype(int)
df_prices['semester'] = df_prices['semester'].str.replace('S', '').astype(int)
df_prices = df_prices.drop(columns=['time'])

df_prices = df_prices[(df_prices["year"] >= 2016) & (df_prices["year"] <= 2025)].copy()

energy_countries = set(df_energy_rounded['country'].unique())
df_prices = df_prices[df_prices['country'].isin(energy_countries)]

# average the two semesters into a single yearly price
#df_prices = (
   # df_prices
    #.groupby(['country', 'year'], as_index=False)
   #.agg(price_eur_mwh=('price_eur_mwh', 'mean'))
#)


#df_prices['price_eur_mwh'] = df_prices['price_eur_mwh'].round(3)

df_uk['price_eur_kwh'] = df_uk['price_eur_kwh'] * 0.95
df_prices = pd.concat(
    [df_prices, df_uk[['country', 'price_eur_kwh', 'year', 'semester']]],
    ignore_index=True
)

#---------------------- EU / Non-EU price aggregation ----------------------
agg_names = ['EU', 'Non-EU']

real_prices = df_prices[~df_prices['country'].isin(agg_names)].copy()
real_prices = real_prices[real_prices['price_eur_kwh'].notna() & (real_prices['price_eur_kwh'] > 0)]

real_prices['region'] = [
    'EU' if is_eu_member(c, y) else 'Non-EU'
    for c, y in zip(real_prices['country'], real_prices['year'])
]

region_prices = (
    real_prices.groupby(['region', 'year', 'semester'], as_index=False)
    .agg(price_eur_kwh=('price_eur_kwh', 'mean'))
    .rename(columns={'region': 'country'})
)

df_prices = pd.concat(
    [df_prices[~df_prices['country'].isin(agg_names)], region_prices],
    ignore_index=True
)
#---------------------------------------------------------------------------

df_prices['price_eur_kwh'] = df_prices['price_eur_kwh'].round(3)
df_prices = df_prices.sort_values(['country', 'year', 'semester']).reset_index(drop=True)
df_prices.to_csv("../export/prices.csv", index=False)

#------------------------------monthly data processing and export---------------------------------------------
df_monthly = pd.read_csv("./release_generation_monthly_lower.csv")

keep_cols_monthly = [
    "Area", "Date",
    "Electricity source", "Generation (TWh)", "Share of generation (%)",
    "Emissions (MtCO2e)", "Share of emissions (%)", "Emissions intensity (gCO2e/kWh)"
]

df_monthly = df_monthly[keep_cols_monthly].rename(columns={
    "Area": "country", "Date": "date",
    "Electricity source": "source",
    "Generation (TWh)": "generation_twh",
    "Emissions (MtCO2e)": "emissions_mtco2e",
    "Share of generation (%)": "share_pct",
    "Emissions intensity (gCO2e/kWh)": "emissions_intensity_gco2e_kwh",
})

df_monthly['date'] = pd.to_datetime(df_monthly['date'])
df_monthly['year'] = df_monthly['date'].dt.year
df_monthly['month'] = df_monthly['date'].dt.month

keep_sources = [
    "Total generation", "Net imports", "Demand",
    "Clean", "Fossil", "Renewables", "Nuclear",
    "Wind", "Solar", "Hydro", "Bioenergy", "Other renewables",
    "Coal", "Gas", "Other fossil",
]

df_monthly = df_monthly[df_monthly["source"].isin(keep_sources)].copy()
df_monthly = df_monthly[(df_monthly['year'] >= 2015) & (df_monthly['year'] <= 2025)].reset_index(drop=True)

# ---------------------------- EU / Non-EU membership ----------------------------
eu_accession_year = {
    'Belgium': 1958, 'France': 1958, 'Germany': 1958, 'Italy': 1958,
    'Luxembourg': 1958, 'Netherlands': 1958,
    'Denmark': 1973, 'Ireland': 1973,
    'Greece': 1981,
    'Portugal': 1986, 'Spain': 1986,
    'Austria': 1995, 'Finland': 1995, 'Sweden': 1995,
    'Cyprus': 2004, 'Czechia': 2004, 'Estonia': 2004, 'Hungary': 2004,
    'Latvia': 2004, 'Lithuania': 2004, 'Malta': 2004, 'Poland': 2004,
    'Slovakia': 2004, 'Slovenia': 2004,
    'Bulgaria': 2007, 'Romania': 2007,
    'Croatia': 2013,
}
uk_start, uk_end = pd.Timestamp('1973-01-01'), pd.Timestamp('2020-02-01')  # left 31 Jan 2020

def is_eu_member(country, date):
    if country == 'United Kingdom':
        return uk_start <= date < uk_end
    return eu_accession_year.get(country, 9999) <= date.year

# Drop pre-aggregated areas (EU, World, regions...) so nothing is double counted
aggregate_areas = ['EU', 'EU2', 'Non-EU', 'World', 'Europe', 'Asia', 'Africa', 'Oceania',
                   'North America', 'Latin America and Caribbean', 'OECD', 'G7', 'G20', 'ASEAN']
df_monthly = df_monthly[~df_monthly['country'].isin(aggregate_areas)].copy()

# Label each country-month as EU / Non-EU (used for the regional aggregates)
df_monthly['region'] = [
    'EU' if is_eu_member(c, d) else 'Non-EU'
    for c, d in zip(df_monthly['country'], df_monthly['date'])
]

# ---------------------------- Build monthly tables ----------------------------
def build_monthly(df, area_col, area_type):
    """Sum by area/source/year/month, then recompute shares and intensity."""
    out = (
        df.groupby([area_col, 'source', 'year', 'month'], as_index=False)
        .agg(
            total_generated=('generation_twh', 'sum'),
            total_emissions=('emissions_mtco2e', 'sum'),
        )
    )

    totals = (
        out[out['source'] == 'Total generation']
        [[area_col, 'year', 'month', 'total_generated']]
        .rename(columns={'total_generated': 'month_total'})
    )
    out = out.merge(totals, on=[area_col, 'year', 'month'], how='left')

    out['share_pct'] = out['total_generated'] / out['month_total'] * 100
    out['emissions_intensity_gco2e_kwh'] = out['total_emissions'] / out['total_generated'] * 1000

    out = out.drop(columns='month_total')
    out = out.rename(columns={area_col: 'area'})
    out['area_type'] = area_type
    return out

countries_data = build_monthly(df_monthly, 'country', 'country')
regions_data   = build_monthly(df_monthly, 'region',  'region')

monthly_data = pd.concat([countries_data, regions_data], ignore_index=True)

for col in ['share_pct', 'total_generated', 'total_emissions', 'emissions_intensity_gco2e_kwh']:
    monthly_data[col] = monthly_data[col].round(3)

monthly_data["source"] = pd.Categorical(monthly_data["source"], categories=hierarchy_order, ordered=True)
monthly_data = (
    monthly_data
    .sort_values(['area_type', 'area', 'year', 'month', 'source'])
    .reset_index(drop=True)
)
monthly_data = monthly_data.drop(columns=['total_emissions'])
monthly_data.to_csv("../export/source_month_generated.csv", index=False)
print("Done")