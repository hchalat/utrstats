# 🎾 UTR Stats - Year in Review

A beautiful, tennis-inspired visualization of your Universal Tennis Rating (UTR) year in review. Built with AWS Lambda, DynamoDB, and Puppeteer for serverless scraping and data generation.

**Live Demo:** [https://utrstats.com](https://utrstats.com)

![UTR Year in Review](https://via.placeholder.com/800x400/1a1a2e/eaeaea?text=UTR+Year+in+Review+Screenshot)

## ✨ Features

A year-round stats site with five tabs, singles **and** doubles, and automatic weekly data refresh.

### 📊 Dashboard
- **Form strip** - Last 10 results at a glance plus current streak
- **Time windows** - All Time / 12 Month / YTD / 6 / 3 / 1 Month, with delta chips comparing each window to your career baseline
- **Activity history** - Matches, sets, games, decisive-set matches, straight-set matches, and tiebreaker sets (W/L for each)
- **Recent matches** - Scores, opponent UTRs, and your rating change per match

### 📈 Trends
- **UTR Journey** - Full multi-year rating chart with peak marker
- **Season by season** - Per-year record, win %, peak and year-end UTR
- **Monthly activity** - Win/loss bars for the last 12 months

### ⚔️ Rivals
- **Career head-to-head** - Nemesis, dominated opponent, closest rival, most-played opponents/teams, partners (doubles), quality wins, revenge wins

### 🆚 Head-to-Head
- **Pick any opponent** - Search by name or choose from your most-played opponents; shareable via `/<id>?vs=<id>`
- **Rivalry record** - Every meeting with scores, plus sets, games, tiebreakers and deciding sets — merged from both players' data
- **Side by side** - Both players' stats and UTR movement for any year (defaults to the current one) or all time

### 🎾 Year in Review
- **Per-year celebration** - Bagels & breadsticks, streaks, comebacks, best win / worst loss, signature set score, best/toughest/busiest month — selectable for any year in your history

### ⚡ Architecture
- **Canonical data bundle** - One per-profile dataset covering all years; all stat windows are computed client-side by a shared engine (`lib/stats.js`) also used by the generator
- **Auto refresh** - Data older than 7 days is re-scraped on visit; a failed refresh falls back to the previous data
- **Serverless** - AWS Lambda + DynamoDB, Puppeteer scraping

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **UTR Sports** for providing comprehensive tennis ratings
- **Chart.js** for beautiful data visualizations
- **Puppeteer** and **@sparticuz/chromium** for Lambda-compatible web scraping
- Tennis community for inspiration and feedback

## 📧 Contact

Harper Chalat - [@hchalat](https://github.com/hchalat)

Project Link: [https://github.com/hchalat/utrstats](https://github.com/hchalat/utrstats)

---

Built with 🎾 love for the tennis community
