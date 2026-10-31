# Hosting the EV Dynamic Pricing Lab

Deploy the React frontend and FastAPI backend together as one web service.
The root Dockerfile builds the frontend and copies it into the Python image.
FastAPI serves the dashboard at `/`, the API at `/api`, and API documentation
at `/docs`. No database is required for the current application.

## Deploy to Render

1. Push this repository, including `Dockerfile`, `.dockerignore`, and
   `render.yaml`, to your GitHub account.
2. Sign in at <https://dashboard.render.com/> and choose **New > Blueprint**.
3. Connect the GitHub repository and choose the branch containing these files.
4. Review the service that Render reads from `render.yaml`. It selects the
   **Free** compute plan. Create the Blueprint to start the build and deploy.
5. Open the public `https://<service-name>.onrender.com` URL shown by Render.
6. Confirm `/api/health` returns `{"status":"ok"}`, scenarios load in the
   dashboard, and a short simulation finishes with working plot downloads.

Render supports building Docker images from a Git repository:
<https://render.com/docs/docker>. Blueprint configuration is documented at
<https://render.com/docs/blueprint-spec>.

For manual service creation, choose **New > Web Service**, connect the repo,
select **Docker**, leave **Root Directory** empty, use `./Dockerfile`, choose
the compute plan, and set **Health Check Path** to `/api/health`. Leave the
Docker command override empty so the image's start command is used.

Do not set `VITE_API_BASE` for this deployment. Production builds use the
website's own origin for API requests. For separate frontend/API hosting,
set `VITE_API_BASE` to the API's HTTPS URL at frontend build time and set
`CORS_ORIGINS` on the API to the frontend's exact origin.

## Choosing compute

The Free plan is a way to try deploying and running small demo workloads;
successful large simulations on its limited CPU and memory are not guaranteed.
Free services spin down after 15 minutes without incoming traffic, take about
a minute to wake up, and may restart at any time. Local generated files are
lost on restarts, redeploys, and spin-down. See current limits:
<https://render.com/docs/free>.

The existing local Sioux Falls benchmark took about 142 seconds for just the
first pricing iteration on a 12-logical-CPU Windows computer in serial mode.
That is one local measurement, not a cloud runtime or full-run estimate.
For substantial runs, start by evaluating an always-on instance with at least
1 CPU and 2 GB RAM, then measure runtime and peak memory before sizing further.
Review the current compute price at <https://render.com/pricing>.

## Application limits

- Run exactly **one instance and one Uvicorn worker**. Job status and results
  live in process memory, so requests routed to another process cannot find them.
- Active jobs and results disappear when the process restarts. On Render's
  default ephemeral filesystem, generated PNGs also disappear. Download results
  you want to keep before restarting or redeploying.
- A persistent disk alone does not preserve job status or resume active jobs.
  Persistent job storage and a separate worker queue are needed for that.
- The current app has no login or request limits. Anyone with access can submit
  simulation jobs. Use it as a small demo; add access controls and job limits
  before opening it to unrestricted public use.
- Keep the browser open while a simulation runs so it can poll progress.
  Avoid redeploying during a run.

## Try the production image locally

With Docker Desktop running, execute from the repository root:

```powershell
docker build -t ev-pricing-lab .
docker run --rm -p 8000:8000 --name ev-pricing-lab ev-pricing-lab
```

Open <http://localhost:8000> and <http://localhost:8000/api/health>.
Use a small scenario and short run before trying full research settings.
