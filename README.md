# Local Finder

A CLI app that uses the **GitHub Copilot SDK** and **Google Places API (New)** to suggest nearby businesses based on a natural-language prompt.

The Copilot LLM picks the right tool — `places_text_search` for natural language queries or `places_nearby_search` for structured type+coordinate lookups — and summarizes the results.

## Setup

```bash
# Install dependencies
uv venv && uv pip install -r requirements.txt

# Set your Google API key (enable Places API at https://console.cloud.google.com/apis)
export GOOGLE_PLACES_API_KEY="your-key-here"

# Make sure the Copilot CLI is installed and authenticated
copilot --version
```

## Usage

```bash
source .venv/bin/activate

python app.py "Find me good ramen near 37.78, -122.41"
python app.py "Best coffee shops within 2km of downtown Austin"
python app.py "Any 24-hour gyms near 40.7128, -74.0060?"
```

The LLM will:
1. Parse your prompt for search terms and location
2. Call the appropriate Google Places tool
3. Summarize the results in a friendly response
