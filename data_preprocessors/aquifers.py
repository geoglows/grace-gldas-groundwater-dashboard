# conda install -c conda-forge geopandas
# download data from http://www.hydroshare.org/resource/73834f47b8b5459a8db4c999e6e3fef6
# see also https://doi.org/10.1038/s41586-023-06879-8

import geopandas as gpd

gdf = (
    gpd
    .read_file('./aquifers/jasechko_et_al_2024_aquifers.shp')
    [['Aquifer', 'Broader', 'geometry']]
    .assign(Broader=lambda df: df['Broader'].str.replace('-', 'ZZZZ'))
    .sort_values(by=['Broader', 'Aquifer'])
    .assign(Broader=lambda df: df['Broader'].str.replace('ZZZZ', ''))
    .to_crs(epsg=4326)
)

# fix a known typo "Bohemian Cretaceuos Basin" -> "Bohemian Cretaceous Basin"
gdf.loc[gdf['Broader'] == 'Bohemian Cretaceuos Basin', 'Broader'] = 'Bohemian Cretaceous Basin'

# drop basins that should not be shown
excluded_basins = [
    'Vienna Basin',
    'Bohemian Cretaceous Basin',
    'Escalante Valley',
    'Blythe Basin',
    'Salt Basin',
    'Caborca Aquifer System',
    'Gippsland Basin',
    'St Vincent Basin',
    'Perth Basin',
    'Lower Athabasca Basin',
    'Urucuia Aquifer System',
]
gdf = gdf[~gdf['Broader'].isin(excluded_basins)]

# drop rows where the area is less than 100 sq km
gdf = gdf[gdf.geometry.to_crs(epsg=6933).area > 100e6]
gdf = gdf[gdf['Broader'] != '']

# merge by Broader field and dissolve geometries
gdf = gdf.dissolve(by='Broader', as_index=False, aggfunc={'Aquifer': 'first'})
gdf = gdf.reset_index(drop=True).reset_index(names='id')
gdf = gdf[['Broader', 'id', 'geometry']].rename(columns={'Broader': 'n'})

gdf.to_parquet('./aquifers.parquet', index=False, engine='pyarrow', compression='gzip')
gdf.to_file('./aquifers.geojson', driver='GeoJSON')
